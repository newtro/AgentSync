#!/usr/bin/env python3
"""foreman — talk to Foreman, Scott's coordinating agent on Grok Bot / xAI.

One task per request, POSTed as JSON to the Foreman webhook. Threads give
continuity; correlation ids match replies. Credentials live in
~/.config/foreman/credentials.env (chmod 600) and are never printed.

Callbacks are agent-owned: the agent that needs an answer starts its own local
sink (and ngrok tunnel) on demand with `--wait`, and stops it when done.
Several harnesses can run side by side — ports and spools are per-agent.

  start   <task> [--title T]      open a new thread and send the first task
  message <thread_id> <task>      continue an existing thread
  close   <thread_id>             close a thread
  threads                         list threads this agent has opened
  await   <correlation_id>        wait for a reply already in flight
  sink    ensure|status|stop|serve   the local callback receiver
  tunnel  ensure|status|stop      the ngrok tunnel in front of the sink
  status                          config, sink, tunnel (key masked)

Flags: --context JSON|@file  --reply-to URL  --wait [--wait-timeout S]
       --from NAME  --json  --dry-run
"""
import argparse, hmac, json, os, re, signal, socket, ssl, subprocess, sys, time
import urllib.error, urllib.request, uuid
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("FOREMAN_CONFIG_DIR", Path.home() / ".config" / "foreman"))
CRED_FILE = CONFIG_DIR / "credentials.env"
THREAD_FILE = CONFIG_DIR / "threads.json"
CALLBACK_DIR = CONFIG_DIR / "callbacks"
PENDING_DIR = CONFIG_DIR / "pending"
RUN_DIR = CONFIG_DIR / "run"
DEFAULT_TIMEOUT = 30
PORT_RANGE = range(4599, 4620)
MAX_CALLBACK_BYTES = 262144
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
NGROK_API = "http://127.0.0.1:4040/api/tunnels"


def die(msg, code=1):
    print(f"foreman: {msg}", file=sys.stderr)
    sys.exit(code)


def note(msg):
    print(f"foreman: {msg}", file=sys.stderr)


# ---------------------------------------------------------------- config ----

def load_config(required=True):
    cfg = {}
    if CRED_FILE.exists():
        if CRED_FILE.stat().st_mode & 0o077:
            note(f"warning: {CRED_FILE} is group/world readable; chmod 600 it")
        for raw in CRED_FILE.read_text().splitlines():
            line = re.sub(r"^export\s+", "", raw.strip())
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in os.environ.items():          # env overrides the file
        if k.startswith("FOREMAN_"):
            cfg[k] = v
    if required:
        for var in ("FOREMAN_WEBHOOK_URL", "FOREMAN_WEBHOOK_KEY"):
            if not cfg.get(var):
                die(f"{var} not set. Put it in {CRED_FILE} (see the foreman skill).")
    return cfg


def agent_name(cfg):
    return cfg.get("FOREMAN_AGENT_NAME") or "claude-code@scott-mac"


def slug(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:40]


def cred_set(key, value):
    """Append or update one line in credentials.env, preserving mode 600."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    lines = CRED_FILE.read_text().splitlines() if CRED_FILE.exists() else []
    out, seen = [], False
    for line in lines:
        if re.match(rf"^\s*(export\s+)?{re.escape(key)}\s*=", line):
            out.append(f"{key}={value}"); seen = True
        else:
            out.append(line)
    if not seen:
        out.append(f"{key}={value}")
    CRED_FILE.write_text("\n".join(out) + "\n")
    CRED_FILE.chmod(0o600)


def callback_token(cfg):
    tok = cfg.get("FOREMAN_CALLBACK_TOKEN")
    if not tok:
        tok = uuid.uuid4().hex
        cred_set("FOREMAN_CALLBACK_TOKEN", tok)
        cfg["FOREMAN_CALLBACK_TOKEN"] = tok
        note("generated a callback path token (kept in credentials.env)")
    return tok


def auth_headers(cfg):
    header = cfg.get("FOREMAN_AUTH_HEADER", "X-Foreman-Key")
    scheme = cfg.get("FOREMAN_AUTH_SCHEME", "")
    key = cfg["FOREMAN_WEBHOOK_KEY"]
    return {header: f"{scheme} {key}".strip() if scheme else key}


# ------------------------------------------------------------------ http ----

def parse(text):
    try:
        return json.loads(text)
    except Exception:
        return None


_SSL_CTX = None


def ssl_context():
    """Some python.org builds ship with an empty trust store (the
    'Install Certificates.command' step). Fall back to certifi's bundle rather
    than ever disabling verification."""
    global _SSL_CTX
    if _SSL_CTX is None:
        ctx = ssl.create_default_context()
        if not ctx.get_ca_certs():
            for loader in (lambda: __import__("certifi").where(),
                           lambda: "/etc/ssl/cert.pem"):
                try:
                    path = loader()
                    if path and os.path.exists(path):
                        ctx.load_verify_locations(path)
                        break
                except Exception:
                    continue
        _SSL_CTX = ctx
    return _SSL_CTX


def http(url, data=None, headers=None, timeout=15, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    kw = {"context": ssl_context()} if url.startswith("https://") else {}
    with urllib.request.urlopen(req, timeout=timeout, **kw) as r:
        return r.status, r.read().decode("utf-8", "replace")


def post_webhook(cfg, payload, timeout=DEFAULT_TIMEOUT):
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "foreman-cli/1"}
    headers.update(auth_headers(cfg))
    for attempt in range(2):
        try:
            status, text = http(cfg["FOREMAN_WEBHOOK_URL"], body, headers, timeout, "POST")
            return status, parse(text), text
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            if e.code >= 500 and attempt == 0:
                time.sleep(2); continue
            return e.code, parse(text), text
        except urllib.error.URLError as e:
            if attempt == 0:
                time.sleep(2); continue
            die(f"cannot reach Foreman webhook: {e.reason}")


# --------------------------------------------------------------- threads ----

def read_threads():
    if THREAD_FILE.exists():
        try:
            return json.loads(THREAD_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_thread(thread_id, **fields):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = read_threads()
    entry = data.get(thread_id, {"thread_id": thread_id, "messages": 0,
                                 "opened": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    entry.update({k: v for k, v in fields.items() if v is not None})
    entry["last_seen"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    data[thread_id] = entry
    THREAD_FILE.write_text(json.dumps(data, indent=2))
    try:
        THREAD_FILE.chmod(0o600)
    except OSError:
        pass


# ------------------------------------------------------------------ sink ----
# The sink is per-agent: its spool and pidfile are keyed by FOREMAN_AGENT_NAME,
# so a second harness (Codex) running its own sink never steals this one's
# replies. Whoever needs a callback starts one; ports are negotiated.

def spool_dir(cfg):
    return CALLBACK_DIR / slug(agent_name(cfg))


def pid_file(cfg):
    return RUN_DIR / f"sink-{slug(agent_name(cfg))}.json"


def sink_health(port, timeout=2):
    try:
        status, text = http(f"http://127.0.0.1:{port}/health", timeout=timeout)
        if status == 200:
            return parse(text)
    except Exception:
        pass
    return None


def port_free(port):
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port)); return True
        except OSError:
            return False


def running_sink(cfg):
    """Return (port, health) for this agent's sink if it is up."""
    pf = pid_file(cfg)
    if pf.exists():
        try:
            rec = json.loads(pf.read_text())
        except Exception:
            rec = {}
        h = sink_health(rec.get("port", 0))
        if h and h.get("spool") == str(spool_dir(cfg)):
            return rec.get("port"), h
    for port in PORT_RANGE:                      # pidfile lost; re-find our own
        h = sink_health(port, timeout=1)
        if h and h.get("spool") == str(spool_dir(cfg)):
            return port, h
    return None, None


def sink_ensure(cfg, quiet=False):
    port, h = running_sink(cfg)
    if port:
        if not quiet:
            note(f"sink already listening on 127.0.0.1:{port} for {agent_name(cfg)}")
        return port
    callback_token(cfg)
    for candidate in PORT_RANGE:
        if not port_free(candidate):
            continue                              # someone else's sink or service
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        log = RUN_DIR / f"sink-{slug(agent_name(cfg))}.log"
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "sink", "serve",
             "--port", str(candidate)],
            stdout=open(log, "ab"), stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True,
            env={**os.environ, "FOREMAN_CONFIG_DIR": str(CONFIG_DIR)})
        for _ in range(50):
            if sink_health(candidate, timeout=1):
                pid_file(cfg).write_text(json.dumps(
                    {"pid": proc.pid, "port": candidate, "agent": agent_name(cfg)}))
                if not quiet:
                    note(f"started callback sink on 127.0.0.1:{candidate} (pid {proc.pid}), log {log}")
                return candidate
            if proc.poll() is not None:
                break
            time.sleep(0.2)
        proc.terminate()
    die("could not start a callback sink on any port in "
        f"{PORT_RANGE.start}-{PORT_RANGE.stop - 1}")


def sink_stop(cfg):
    pf = pid_file(cfg)
    if not pf.exists():
        print("no sink recorded for this agent"); return
    rec = json.loads(pf.read_text())
    try:
        os.kill(rec["pid"], signal.SIGTERM)
        print(f"stopped sink pid {rec['pid']} (port {rec.get('port')})")
    except ProcessLookupError:
        print("sink was not running")
    pf.unlink(missing_ok=True)


def sink_serve(cfg, port):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    spool = spool_dir(cfg); spool.mkdir(parents=True, exist_ok=True)
    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    token = callback_token(cfg)
    accept_any = cfg.get("FOREMAN_SINK_ACCEPT_ANY") == "1"

    class Handler(BaseHTTPRequestHandler):
        server_version = "foreman-sink/1"

        def log_message(self, fmt, *a):
            sys.stdout.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {self.address_string()} "
                             f"{fmt % a}\n")
            sys.stdout.flush()

        def reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def route(self):
            """-> correlation_id, or None if the path is not a valid callback path."""
            parts = [p for p in self.path.split("?")[0].split("/") if p]
            if len(parts) != 3 or parts[0] != "cb":
                return None
            if not hmac.compare_digest(parts[1], token):
                return False
            return parts[2] if UUID_RE.match(parts[2]) else None

        def do_GET(self):
            if self.path.split("?")[0] == "/health":
                return self.reply(200, {"foreman_sink": True, "agent": agent_name(cfg),
                                        "spool": str(spool), "port": port})
            cid = self.route()
            if cid in (None, False):
                return self.reply(404, {"error": "not found"})
            f = spool / f"{cid}.json"
            if not f.exists():
                return self.reply(404, {"error": "no reply yet"})
            return self.reply(200, json.loads(f.read_text()))

        def do_POST(self):
            cid = self.route()
            if cid is False:
                self.log_message("rejected callback: bad token")
                return self.reply(403, {"error": "forbidden"})
            if cid is None:
                return self.reply(404, {"error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_CALLBACK_BYTES:
                return self.reply(413, {"error": "too large"})
            payload = parse(self.rfile.read(length).decode("utf-8", "replace"))
            if payload is None:
                return self.reply(400, {"error": "body must be JSON"})
            if not accept_any and not (PENDING_DIR / f"{cid}.json").exists():
                self.log_message(f"rejected callback for unknown correlation_id {cid}")
                return self.reply(404, {"error": "unknown correlation_id"})
            payload.setdefault("correlation_id", cid)
            payload["_received"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            (spool / f"{cid}.json").write_text(json.dumps(payload, indent=2))
            (PENDING_DIR / f"{cid}.json").unlink(missing_ok=True)
            self.log_message(f"stored callback for {cid}")
            return self.reply(200, {"ok": True})

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"foreman sink for {agent_name(cfg)} on 127.0.0.1:{port}, spool {spool}")
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


# ---------------------------------------------------------------- tunnel ----

def ngrok_tunnels():
    try:
        status, text = http(NGROK_API, headers={"Accept": "application/json"}, timeout=3)
        return (parse(text) or {}).get("tunnels", [])
    except Exception:
        return None


def tunnel_for_port(port):
    tunnels = ngrok_tunnels()
    if not tunnels:
        return None
    for t in tunnels:
        addr = (t.get("config") or {}).get("addr", "")
        if addr.endswith(f":{port}") and str(t.get("public_url", "")).startswith("https://"):
            return t["public_url"]
    return None


def tunnel_ensure(cfg, port, quiet=False):
    existing = tunnel_for_port(port)
    if existing:
        if not quiet:
            note(f"reusing ngrok tunnel {existing} -> 127.0.0.1:{port}")
        return existing
    if not (subprocess.run(["which", "ngrok"], capture_output=True).returncode == 0):
        die("ngrok is not installed. `brew install --cask ngrok`, then "
            "`ngrok config add-authtoken <your token>` (run that yourself — "
            "don't paste the token into a session).")
    others = ngrok_tunnels()
    domain = cfg.get("FOREMAN_NGROK_DOMAIN")
    cmd = ["ngrok", "http", str(port), "--log", "stdout"]
    if domain:
        if others:                      # the reserved domain may be held by the other harness
            for t in others:
                if domain in str(t.get("public_url", "")):
                    note(f"reserved domain {domain} is already in use by another tunnel; "
                         "taking an ephemeral URL instead")
                    domain = None
                    break
        if domain:
            cmd += ["--url", f"https://{domain}"]
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    log = RUN_DIR / f"ngrok-{slug(agent_name(cfg))}.log"
    proc = subprocess.Popen(cmd, stdout=open(log, "ab"), stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(60):
        url = tunnel_for_port(port)
        if url:
            (RUN_DIR / f"tunnel-{slug(agent_name(cfg))}.json").write_text(
                json.dumps({"pid": proc.pid, "port": port, "url": url}))
            if not quiet:
                note(f"started ngrok tunnel {url} -> 127.0.0.1:{port} (pid {proc.pid})")
            return url
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    tail = log.read_text()[-600:] if log.exists() else ""
    die(f"ngrok did not come up. Last log lines:\n{tail}")


def tunnel_stop(cfg):
    tf = RUN_DIR / f"tunnel-{slug(agent_name(cfg))}.json"
    if not tf.exists():
        print("no tunnel recorded for this agent"); return
    rec = json.loads(tf.read_text())
    try:
        os.kill(rec["pid"], signal.SIGTERM)
        print(f"stopped ngrok pid {rec['pid']} ({rec.get('url')})")
    except ProcessLookupError:
        print("tunnel was not running")
    tf.unlink(missing_ok=True)


# ------------------------------------------------------------------ send ----

def load_context(spec):
    if not spec:
        return {}
    if spec.startswith("@"):
        spec = Path(spec[1:]).expanduser().read_text()
    try:
        ctx = json.loads(spec)
    except json.JSONDecodeError as e:
        die(f"--context must be JSON (or @file.json): {e}")
    if not isinstance(ctx, dict):
        die("--context must be a JSON object")
    return ctx


def callback_base(cfg, quiet=False):
    """Bring up this agent's own sink + tunnel and return the public base URL."""
    if cfg.get("FOREMAN_CALLBACK_BASE"):
        return cfg["FOREMAN_CALLBACK_BASE"].rstrip("/")
    port = sink_ensure(cfg, quiet=quiet)
    public = tunnel_ensure(cfg, port, quiet=quiet)
    return f"{public.rstrip('/')}/cb/{callback_token(cfg)}"


def mark_pending(correlation_id):
    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    (PENDING_DIR / f"{correlation_id}.json").write_text(json.dumps(
        {"correlation_id": correlation_id, "sent": time.strftime("%Y-%m-%dT%H:%M:%S%z")}))


def spooled(cfg, correlation_id):
    f = spool_dir(cfg) / f"{correlation_id}.json"
    if f.exists():
        try:
            return json.loads(f.read_text())
        except Exception:
            return None
    return None


def wait_for_callback(cfg, correlation_id, timeout):
    deadline = time.time() + timeout
    delay = 1.0
    while time.time() < deadline:
        hit = spooled(cfg, correlation_id)
        if hit:
            return hit
        time.sleep(delay)
        delay = min(delay * 1.4, 10)
    return spooled(cfg, correlation_id)


def emit(args, status, payload, text, extra=None):
    if args.json:
        out = dict(extra or {})
        out.update({"http_status": status,
                    "response": payload if payload is not None else text})
        print(json.dumps(out, indent=2)); return
    for k, v in (extra or {}).items():
        print(f"{k}: {v}")
    print(f"http_status: {status}")
    if payload is not None:
        print(json.dumps(payload, indent=2))
    elif text.strip():
        print(text.strip()[:2000])


def send(args, action=None):
    cfg = load_config()
    correlation_id = str(uuid.uuid4())
    thread_id = getattr(args, "thread_id", None) or str(uuid.uuid4())
    sender = args.sender or agent_name(cfg)

    payload = {"from": sender, "thread_id": thread_id, "correlation_id": correlation_id}
    if action:
        payload["action"] = action
    else:
        if getattr(args, "title", None):
            payload["title"] = args.title
        payload["task"] = args.task
        payload["context"] = load_context(args.context)
        reply_to = args.reply_to or (callback_base(cfg) + "/" + correlation_id
                                     if args.wait else None)
        if reply_to:
            payload["reply_to"] = reply_to
            mark_pending(correlation_id)

    if args.dry_run:
        print(json.dumps(payload, indent=2)); return

    status, resp, text = post_webhook(cfg, payload, timeout=args.timeout)
    if action == "close":
        save_thread(thread_id, closed=True)
    else:
        entry = read_threads().get(thread_id, {})
        save_thread(thread_id, title=getattr(args, "title", None) or entry.get("title"),
                    messages=entry.get("messages", 0) + 1,
                    last_correlation_id=correlation_id, last_task=args.task[:200],
                    last_run_uuid=(resp or {}).get("runUuid") if isinstance(resp, dict) else None)
    emit(args, status, resp, text, {"thread_id": thread_id, "correlation_id": correlation_id})
    if status >= 400:
        sys.exit(2)
    if action or not args.wait:
        return

    if "reply_to" not in payload:
        # No callback route: the inline response is all there is.
        if isinstance(resp, dict) and resp.get("result") is not None:
            return
        note(f"sent, but nothing came back inline and no callback route was available — "
             f"this was fire-and-forget. Ask Foreman about thread {thread_id}.")
        sys.exit(3)

    note(f"waiting for callback on {correlation_id} (up to {args.wait_timeout}s)…")
    reply = wait_for_callback(cfg, correlation_id, args.wait_timeout)
    if reply is None:
        note(f"no callback yet; the sink keeps listening. Resume with: "
             f"foreman await {correlation_id}")
        sys.exit(3)
    print(json.dumps(reply, indent=2))


# -------------------------------------------------------------- commands ----

def cmd_threads(args):
    data = read_threads()
    if not data:
        print("no threads opened from this machine yet"); return
    if args.json:
        print(json.dumps(data, indent=2)); return
    for t in sorted(data.values(), key=lambda e: e.get("last_seen", "")):
        print(f"{t['thread_id']}  {'closed' if t.get('closed') else 'open':6}  "
              f"msgs={t.get('messages', 0)}  {t.get('title') or t.get('last_task', '')}")


def cmd_await(args):
    cfg = load_config()
    if spooled(cfg, args.correlation_id) is None:
        sink_ensure(cfg, quiet=True)
    reply = wait_for_callback(cfg, args.correlation_id, args.wait_timeout)
    if reply is None:
        die("no callback received before timeout", 3)
    print(json.dumps(reply, indent=2))


def cmd_sink(args):
    cfg = load_config(required=args.sink_cmd != "serve")
    if args.sink_cmd == "serve":
        return sink_serve(load_config(required=False), args.port)
    if args.sink_cmd == "ensure":
        port = sink_ensure(cfg)
        print(f"sink: 127.0.0.1:{port}  spool: {spool_dir(cfg)}"); return
    if args.sink_cmd == "stop":
        return sink_stop(cfg)
    port, h = running_sink(cfg)
    print(f"sink: 127.0.0.1:{port} (up)" if port else "sink: not running")
    if port:
        print(f"spool: {spool_dir(cfg)}  replies: {len(list(spool_dir(cfg).glob('*.json')))}  "
              f"pending: {len(list(PENDING_DIR.glob('*.json')))}")


def cmd_tunnel(args):
    cfg = load_config()
    if args.tunnel_cmd == "stop":
        return tunnel_stop(cfg)
    port, _ = running_sink(cfg)
    if args.tunnel_cmd == "ensure":
        port = port or sink_ensure(cfg)
        print(f"tunnel: {tunnel_ensure(cfg, port)} -> 127.0.0.1:{port}"); return
    url = tunnel_for_port(port) if port else None
    print(f"tunnel: {url} -> 127.0.0.1:{port}" if url else "tunnel: none for this agent's sink")


def cmd_status(args):
    cfg = load_config()
    key = cfg["FOREMAN_WEBHOOK_KEY"]
    port, _ = running_sink(cfg)
    url = tunnel_for_port(port) if port else None
    ng = ngrok_tunnels()
    print(f"credentials : {CRED_FILE}")
    print(f"webhook_url : {cfg['FOREMAN_WEBHOOK_URL']}")
    print(f"auth        : {cfg.get('FOREMAN_AUTH_HEADER', 'X-Foreman-Key')}"
          f"{' ' + cfg['FOREMAN_AUTH_SCHEME'] if cfg.get('FOREMAN_AUTH_SCHEME') else ''} "
          f"{key[:4]}…{key[-4:]} ({len(key)} chars)")
    print(f"agent       : {agent_name(cfg)}")
    print(f"sink        : {'127.0.0.1:' + str(port) if port else 'not running (starts on --wait)'}")
    print(f"tunnel      : {url or ('ngrok agent up, no tunnel for this sink' if ng is not None else 'ngrok agent not running')}")
    print(f"callback    : {cfg.get('FOREMAN_CALLBACK_BASE') or (url + '/cb/…' if url else 'created on demand by --wait')}")
    print(f"threads     : {len(read_threads())} in {THREAD_FILE}")
    print(f"pending     : {len(list(PENDING_DIR.glob('*.json'))) if PENDING_DIR.exists() else 0} awaiting reply")


def main():
    p = argparse.ArgumentParser(prog="foreman", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--json", action="store_true", help="machine-readable output")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_json(sp):
        # also accept --json after the subcommand; SUPPRESS keeps the global one
        sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS,
                        help="machine-readable output")

    def send_flags(sp):
        add_json(sp)
        sp.add_argument("--context", help="JSON object, or @path/to/file.json")
        sp.add_argument("--reply-to", help="explicit HTTPS URL for the result")
        sp.add_argument("--wait", action="store_true",
                        help="start this agent's sink+tunnel, ask for a callback, wait for it")
        sp.add_argument("--wait-timeout", type=int, default=600)
        sp.add_argument("--from", dest="sender", help="override the 'from' agent name")
        sp.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
        sp.add_argument("--dry-run", action="store_true", help="print the envelope, send nothing")

    s = sub.add_parser("start", help="open a new thread")
    s.add_argument("task"); s.add_argument("--title")
    send_flags(s); s.set_defaults(func=lambda a: send(a))

    m = sub.add_parser("message", help="continue a thread")
    m.add_argument("thread_id"); m.add_argument("task")
    send_flags(m); m.set_defaults(title=None, func=lambda a: send(a))

    c = sub.add_parser("close", help="close a thread")
    c.add_argument("thread_id"); c.add_argument("--from", dest="sender")
    c.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    c.add_argument("--dry-run", action="store_true"); add_json(c)
    c.set_defaults(task="", context=None, reply_to=None, wait=False, wait_timeout=0,
                   func=lambda a: send(a, action="close"))

    t = sub.add_parser("threads"); add_json(t); t.set_defaults(func=cmd_threads)

    a = sub.add_parser("await", help="wait for a reply already in flight")
    a.add_argument("correlation_id"); a.add_argument("--wait-timeout", type=int, default=600)
    add_json(a)
    a.set_defaults(func=cmd_await)

    sk = sub.add_parser("sink", help="the local callback receiver")
    sksub = sk.add_subparsers(dest="sink_cmd", required=True)
    for name in ("ensure", "status", "stop"):
        sksub.add_parser(name)
    srv = sksub.add_parser("serve", help="run in the foreground (used internally)")
    srv.add_argument("--port", type=int, required=True)
    sk.set_defaults(func=cmd_sink)

    tn = sub.add_parser("tunnel", help="the ngrok tunnel in front of the sink")
    tnsub = tn.add_subparsers(dest="tunnel_cmd", required=True)
    for name in ("ensure", "status", "stop"):
        tnsub.add_parser(name)
    tn.set_defaults(func=cmd_tunnel)

    st = sub.add_parser("status"); add_json(st); st.set_defaults(func=cmd_status)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
