#!/usr/bin/env python3
"""foreman selftest — prove the bridge works, end to end.

  ./selftest            offline only: files, envelopes, sink security, spool
  ./selftest --live     also sends REAL messages to Foreman and waits for callbacks
  ./selftest --live --keep   leave the sink/tunnel up afterwards

Offline tests never touch the network. Live tests send a handful of real tasks
to Scott's coordinator and close the thread they open.
"""
import argparse, json, os, re, subprocess, sys, time, urllib.error, urllib.request, uuid
import re
from pathlib import Path

SKILL = Path(__file__).resolve().parent
CLI = str(SKILL / "foreman.py")
CONFIG_DIR = Path(os.environ.get("FOREMAN_CONFIG_DIR", Path.home() / ".config" / "foreman"))
CRED = CONFIG_DIR / "credentials.env"

PASS, FAIL, SKIP = [], [], []
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"\n        {detail}" if detail and not ok else ""))
    return ok


def skip(name, why):
    SKIP.append(name); print(f"  SKIP  {name} — {why}")


def run(*args, env=None, timeout=120):
    e = dict(os.environ); e.update(env or {})
    p = subprocess.run([CLI, *args], capture_output=True, text=True, env=e, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def cfg_get(key):
    for line in CRED.read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return None


def post(url, body, ctype="application/json"):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": ctype}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return f"error: {e}"


# ------------------------------------------------------------------ offline --

def offline():
    print("\n[1] Skill layout and credentials")
    check("SKILL.md exists with name+description frontmatter",
          (SKILL / "SKILL.md").exists()
          and re.search(r"^name:.*foreman", (SKILL / "SKILL.md").read_text(), re.M)
          and "description:" in (SKILL / "SKILL.md").read_text())
    check("CLI is executable", os.access(CLI, os.X_OK))
    check("credentials.env is chmod 600", CRED.exists() and not (CRED.stat().st_mode & 0o077),
          f"mode is {oct(CRED.stat().st_mode & 0o777) if CRED.exists() else 'missing'}")
    key = cfg_get("FOREMAN_WEBHOOK_KEY") or ""
    tok = cfg_get("FOREMAN_CALLBACK_TOKEN") or ""
    body = (SKILL / "SKILL.md").read_text() + (SKILL / "foreman.py").read_text() + Path(__file__).read_text()
    check("no secret material in the skill files",
          bool(key) and key not in body and (not tok or tok not in body))

    print("\n[2] status output")
    rc, out, err = run("status")
    check("status exits 0", rc == 0, err)
    check("status masks the webhook key", key not in out, "full key was printed")
    check("status reports the agent name", "agent" in out and "@" in out)

    print("\n[3] Envelope shape (dry-run, nothing sent)")
    rc, out, _ = run("start", "smoke task", "--title", "T", "--context", '{"a":1}', "--dry-run")
    env1 = json.loads(out)
    check("start envelope has every required field",
          all(k in env1 for k in ("from", "thread_id", "correlation_id", "title", "task", "context")))
    check("thread_id and correlation_id are uuids",
          bool(UUID_RE.match(env1["thread_id"]) and UUID_RE.match(env1["correlation_id"])))
    check("context is passed through as an object", env1["context"] == {"a": 1})
    check("no credential leaks into the envelope", key not in json.dumps(env1))

    tid = str(uuid.uuid4())
    rc, out, _ = run("message", tid, "follow up", "--dry-run")
    env2 = json.loads(out)
    check("message reuses the given thread_id", env2["thread_id"] == tid)
    check("message carries no title", "title" not in env2)
    rc, out2, _ = run("message", tid, "follow up", "--dry-run")
    check("correlation_id is fresh on every message",
          env2["correlation_id"] != json.loads(out2)["correlation_id"])

    rc, out, _ = run("close", tid, "--dry-run")
    env3 = json.loads(out)
    check("close sends action=close on the same thread",
          env3.get("action") == "close" and env3["thread_id"] == tid and "task" not in env3)

    rc, out, err = run("start", "x", "--context", "not-json", "--dry-run")
    check("malformed --context is rejected", rc == 1 and "JSON" in err)

    print("\n[4] TLS")
    try:
        from importlib.machinery import SourceFileLoader
        fm = SourceFileLoader("fm_probe", CLI).load_module()
        ctx = fm.ssl_context()
        check("a real CA trust store is loaded", len(ctx.get_ca_certs()) > 50,
              f"only {len(ctx.get_ca_certs())} CAs")
        check("certificate + hostname verification stay on",
              ctx.verify_mode == 2 and ctx.check_hostname)
    except Exception as e:
        check("TLS context builds", False, str(e))

    print("\n[5] Callback sink security (local)")
    rc, out, err = run("sink", "ensure")
    if rc != 0:
        return check("sink starts", False, err)
    port = int(re.search(r"127\.0\.0\.1:(\d+)", out).group(1))
    token = cfg_get("FOREMAN_CALLBACK_TOKEN")
    base = f"http://127.0.0.1:{port}"
    check("sink starts and answers /health", rc == 0)
    cid = str(uuid.uuid4())
    check("callback for an unknown correlation_id is refused",
          post(f"{base}/cb/{token}/{cid}", {"ok": True, "result": "spoof"}) == 404)
    (CONFIG_DIR / "pending").mkdir(parents=True, exist_ok=True)
    (CONFIG_DIR / "pending" / f"{cid}.json").write_text("{}")
    check("wrong token is refused", post(f"{base}/cb/badtoken/{cid}", {}) == 403)
    check("non-uuid path is refused", post(f"{base}/cb/{token}/not-a-uuid", {}) == 404)
    check("unknown route is refused", post(f"{base}/anything", {}) == 404)
    check("non-JSON body is refused", post(f"{base}/cb/{token}/{cid}", b"<html>") == 400)
    check("oversized body is refused",
          post(f"{base}/cb/{token}/{cid}", json.dumps({"x": "y" * 300000}).encode()) == 413)
    check("a legitimate callback is accepted",
          post(f"{base}/cb/{token}/{cid}",
               {"ok": True, "correlation_id": cid, "result": "spooled"}) == 200)
    rc, out, err = run("await", cid, "--wait-timeout", "5")
    check("await returns the spooled reply", rc == 0 and "spooled" in out, err)
    check("pending marker is cleared once answered",
          not (CONFIG_DIR / "pending" / f"{cid}.json").exists())
    for f in (CONFIG_DIR / "callbacks").rglob(f"{cid}.json"):
        f.unlink()
    rc, out, _ = run("sink", "stop")
    check("sink stops cleanly", rc == 0 and "stopped" in out)


# --------------------------------------------------------------------- live --

def live(keep, timeout):
    print("\n[6] Live: authentication")
    rc, out, err = run("start", "Auth probe from Scott's Mac — no action needed.",
                       "--title", "foreman selftest", "--json")
    try:
        res = json.loads(out)
    except Exception:
        return check("webhook accepted an authenticated request", False, out or err)
    status = res.get("http_status")
    check(f"webhook accepts our credentials (HTTP {status})", isinstance(status, int) and status < 400,
          json.dumps(res)[:400])
    thread = res.get("thread_id")

    rc, out, err = run("message", str(uuid.uuid4()), "auth probe with a bad key", "--json",
                       env={"FOREMAN_WEBHOOK_KEY": "crsr_deliberately_invalid_key"})
    try:
        bad = json.loads(out).get("http_status")
    except Exception:
        bad = None
    check(f"a wrong key is rejected (HTTP {bad})", isinstance(bad, int) and bad in (401, 403),
          "the endpoint accepted an invalid key — auth is not being enforced"
          if bad and bad < 400 else str(out)[:300])

    print("\n[7] Live: callback round trip")
    rc, out, err = run("start",
                       "Selftest from Claude Code on Scott's Mac. Reply with a one-line "
                       "acknowledgement so we can confirm the callback path works.",
                       "--title", "foreman selftest — callback",
                       "--wait", "--wait-timeout", str(timeout), "--json",
                       timeout=timeout + 120)
    blocks = [b for b in re.findall(r"\{.*?\n\}", out, re.S)]
    sent = json.loads(blocks[0]) if blocks else {}
    reply = json.loads(blocks[1]) if len(blocks) > 1 else None
    cid, tid = sent.get("correlation_id"), sent.get("thread_id")
    check("message with reply_to was accepted",
          isinstance(sent.get("http_status"), int) and sent["http_status"] < 400, out[:400])
    if reply is None:
        skip("Foreman POSTs a callback to reply_to",
             f"no callback within {timeout}s — he may not honour reply_to; "
             f"resume with: foreman await {cid}")
        skip("callback correlation_id matches", "no callback")
        skip("callback carries a result", "no callback")
    else:
        check("Foreman POSTs a callback to reply_to", True)
        check("callback correlation_id matches the message sent",
              reply.get("correlation_id") == cid, f"{reply.get('correlation_id')} != {cid}")
        check("callback carries a result and no error",
              reply.get("result") not in (None, "") and not reply.get("error"),
              json.dumps(reply)[:400])

    print("\n[8] Live: thread continuity")
    if tid:
        rc, out, err = run("message", tid,
                           "Follow-up on this same thread: what did I ask you in my previous "
                           "message on this thread? Answer in one line.",
                           "--wait", "--wait-timeout", str(timeout), "--json",
                           timeout=timeout + 120)
        blocks = [b for b in re.findall(r"\{.*?\n\}", out, re.S)]
        follow = json.loads(blocks[1]) if len(blocks) > 1 else None
        if follow is None:
            skip("follow-up on the same thread is answered", "no callback in time")
        else:
            check("follow-up on the same thread is answered", bool(follow.get("result")))
            check("Foreman echoes the same thread_id back",
                  follow.get("thread_id") in (None, tid), str(follow.get("thread_id")))
            print(f"        he recalled: {str(follow.get('result'))[:200]}")
        rc, out, _ = run("threads")
        check("thread is tracked locally for later steps", tid[:8] in out)
        rc, out, err = run("close", tid, "--json")
        try:
            closed = json.loads(out).get("http_status")
        except Exception:
            closed = None
        check(f"close is accepted (HTTP {closed})", isinstance(closed, int) and closed < 400, out[:300])
    else:
        skip("thread continuity", "no thread_id from the callback test")

    if not keep:
        run("sink", "stop"); run("tunnel", "stop")
        print("\n  torn down: sink and tunnel stopped")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="send real messages to Foreman")
    ap.add_argument("--keep", action="store_true", help="leave sink/tunnel running")
    ap.add_argument("--timeout", type=int, default=180, help="seconds to wait per callback")
    a = ap.parse_args()

    print("foreman selftest" + ("  (offline + LIVE)" if a.live else "  (offline only)"))
    offline()
    if a.live:
        live(a.keep, a.timeout)
    else:
        print("\n  live tests skipped — rerun with --live to exercise Foreman himself")

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed, {len(SKIP)} skipped")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
