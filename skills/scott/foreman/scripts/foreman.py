#!/usr/bin/env python3
"""Send correlated tasks to Scott's Foreman Grok Bot webhook."""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None

try:
    import certifi
except ImportError:  # pragma: no cover - system CA fallback
    certifi = None


MAX_CALLBACK_BYTES = 1_048_576
DEFAULT_DISPATCH_TIMEOUT_SECONDS = 60.0
DEFAULT_NGROK_START_TIMEOUT_SECONDS = 45.0


class ForemanError(RuntimeError):
    """A safe-to-display Foreman client error."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _valid_uuid(value: str, field: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError) as exc:
        raise ForemanError(f"{field} must be a UUID") from exc


def _https_url(value: str, field: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ForemanError(f"{field} must be an HTTPS URL")
    if parsed.username or parsed.password:
        raise ForemanError(f"{field} must not contain embedded credentials")
    return value


def _tls_context() -> ssl.SSLContext:
    """Use certifi when present; some macOS Python builds lack a usable CA bundle."""
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()


def _state_root() -> Path:
    configured = os.environ.get("CODEX_HOME")
    base = Path(configured).expanduser() if configured else Path.home() / ".codex"
    return base / "state" / "foreman"


class ThreadStore:
    """Locked JSON store containing IDs and status, never task content."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = root or _state_root()
        self.path = self.root / "threads.json"
        self.lock_path = self.root / "threads.lock"

    def _prepare(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.root, 0o700)
        except OSError:
            pass

    def _locked(self):
        self._prepare()
        handle = self.lock_path.open("a+", encoding="utf-8")
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        return handle

    def _load_unlocked(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "threads": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ForemanError("Foreman thread store is unreadable") from exc
        if not isinstance(data, dict) or not isinstance(data.get("threads"), dict):
            raise ForemanError("Foreman thread store has an invalid format")
        return data

    def _save_unlocked(self, data: dict[str, Any]) -> None:
        descriptor, temporary = tempfile.mkstemp(
            prefix="threads-", suffix=".json", dir=self.root
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def update(
        self,
        thread_id: str,
        *,
        title: str | None = None,
        status: str | None = None,
        correlation_id: str | None = None,
        callback_state: str | None = None,
    ) -> None:
        lock = self._locked()
        try:
            data = self._load_unlocked()
            threads = data["threads"]
            record = threads.setdefault(
                thread_id,
                {"created_at": _now(), "status": "active", "messages": 0},
            )
            if title and not record.get("title"):
                record["title"] = title
            if status:
                record["status"] = status
            if correlation_id:
                record["last_correlation_id"] = correlation_id
                record["messages"] = int(record.get("messages", 0)) + 1
            if callback_state:
                record["last_callback_state"] = callback_state
            record["updated_at"] = _now()
            self._save_unlocked(data)
        finally:
            lock.close()

    def list(self) -> list[dict[str, Any]]:
        lock = self._locked()
        try:
            data = self._load_unlocked()
        finally:
            lock.close()
        rows = []
        for thread_id, record in data["threads"].items():
            rows.append({"thread_id": thread_id, **record})
        return sorted(rows, key=lambda row: row.get("updated_at", ""), reverse=True)


def _context(value: str | None) -> dict[str, Any]:
    if value is None:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ForemanError("context must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ForemanError("context must be a JSON object")
    return parsed


def _credentials() -> tuple[str, str]:
    url = os.environ.get("FOREMAN_WEBHOOK_URL")
    key = os.environ.get("FOREMAN_WEBHOOK_KEY")
    missing = [
        name
        for name, value in (
            ("FOREMAN_WEBHOOK_URL", url),
            ("FOREMAN_WEBHOOK_KEY", key),
        )
        if not value
    ]
    if missing:
        raise ForemanError("Missing runtime secret variable(s): " + ", ".join(missing))
    return _https_url(url or "", "FOREMAN_WEBHOOK_URL"), key or ""


def _authorization_value(key: str) -> str:
    return key if key.lower().startswith("bearer ") else f"Bearer {key}"


def _post_json(payload: dict[str, Any]) -> tuple[int, dict[str, Any] | None]:
    url, key = _credentials()
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded,
        method="POST",
        headers={
            "Authorization": _authorization_value(key),
            "Content-Type": "application/json",
            "User-Agent": "Codex-Foreman-Skill/1.0",
        },
    )
    raw_timeout = os.environ.get("FOREMAN_DISPATCH_TIMEOUT_SECONDS")
    try:
        timeout = (
            float(raw_timeout)
            if raw_timeout is not None
            else DEFAULT_DISPATCH_TIMEOUT_SECONDS
        )
        if timeout <= 0:
            raise ValueError
    except ValueError as exc:
        raise ForemanError("FOREMAN_DISPATCH_TIMEOUT_SECONDS must be positive") from exc

    try:
        with urllib.request.urlopen(
            request, timeout=timeout, context=_tls_context()
        ) as response:
            body = response.read(MAX_CALLBACK_BYTES + 1)
            if len(body) > MAX_CALLBACK_BYTES:
                raise ForemanError("Webhook acknowledgement was unexpectedly large")
            if not body:
                return response.status, None
            try:
                parsed = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return response.status, None
            return response.status, parsed if isinstance(parsed, dict) else None
    except urllib.error.HTTPError as exc:
        raise ForemanError(
            f"Foreman webhook rejected the request (HTTP {exc.code})"
        ) from exc
    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        raise ForemanError(
            "Foreman dispatch acknowledgement was not received; do not assume the task failed or resend it with a new correlation ID"
        ) from exc


@dataclass
class CallbackWaiter:
    expected_path: str
    thread_id: str
    correlation_id: str
    listen_host: str = "127.0.0.1"
    listen_port: int = 0

    def __post_init__(self) -> None:
        if not self.expected_path.startswith("/"):
            raise ForemanError("callback path must start with /")
        self.event = threading.Event()
        self.result: dict[str, Any] | None = None
        self.server: ThreadingHTTPServer | None = None

    def start(self) -> None:
        waiter = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def _respond(self, status: int, message: str) -> None:
                encoded = json.dumps({"ok": status < 400, "message": message}).encode(
                    "utf-8"
                )
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_POST(self) -> None:  # noqa: N802 - required HTTP handler name
                if urllib.parse.urlparse(self.path).path != waiter.expected_path:
                    self._respond(404, "not found")
                    return
                content_type = self.headers.get("Content-Type", "")
                if "application/json" not in content_type.lower():
                    self._respond(415, "application/json required")
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    self._respond(400, "invalid content length")
                    return
                if length <= 0 or length > MAX_CALLBACK_BYTES:
                    self._respond(413, "invalid callback size")
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._respond(400, "invalid JSON")
                    return
                if not isinstance(payload, dict):
                    self._respond(400, "JSON object required")
                    return
                if (
                    payload.get("thread_id") != waiter.thread_id
                    or payload.get("correlation_id") != waiter.correlation_id
                ):
                    self._respond(409, "callback IDs do not match")
                    return
                if not isinstance(payload.get("ok"), bool):
                    self._respond(400, "callback ok must be boolean")
                    return
                waiter.result = payload
                waiter.event.set()
                self._respond(202, "accepted")

        try:
            self.server = ThreadingHTTPServer(
                (self.listen_host, self.listen_port), Handler
            )
            self.server.daemon_threads = True
        except OSError as exc:
            raise ForemanError(
                f"Could not bind callback listener on {self.listen_host}:{self.listen_port}"
            ) from exc
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def port(self) -> int:
        if self.server is None:
            raise ForemanError("Callback listener has not started")
        return int(self.server.server_port)

    def wait(self, liveness_check=None) -> dict[str, Any]:
        while not self.event.wait(1.0):
            if liveness_check is not None:
                liveness_check()
        if self.result is None:
            raise ForemanError("Callback listener stopped without a result")
        return self.result

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()


def _agent_slug(sender: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", sender.lower()).strip("-")
    return (slug or "agent")[:48]


def _callback_path(sender: str, thread_id: str, correlation_id: str) -> str:
    return f"/foreman/{_agent_slug(sender)}/{thread_id}/{correlation_id}"


def _ngrok_start_timeout() -> float:
    raw_timeout = os.environ.get("FOREMAN_NGROK_START_TIMEOUT_SECONDS")
    try:
        timeout = (
            float(raw_timeout)
            if raw_timeout is not None
            else DEFAULT_NGROK_START_TIMEOUT_SECONDS
        )
        if timeout <= 0:
            raise ValueError
    except ValueError as exc:
        raise ForemanError(
            "FOREMAN_NGROK_START_TIMEOUT_SECONDS must be positive"
        ) from exc
    return timeout


def _ngrok_public_url(line: str) -> str | None:
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        record = None
    if isinstance(record, dict):
        message = str(record.get("msg", "")).lower()
        candidate = record.get("url") or record.get("public_url")
        if (
            isinstance(candidate, str)
            and candidate.startswith("https://")
            and ("started tunnel" in message or "started endpoint" in message)
        ):
            return _https_url(candidate, "ngrok public URL")
    lowered = line.lower()
    if "started tunnel" not in lowered and "started endpoint" not in lowered:
        return None
    match = re.search(r"(?:url=|public_url=)(https://[^\s\"']+)", line)
    if match:
        return _https_url(match.group(1), "ngrok public URL")
    return None


class NgrokTunnel:
    """One ngrok subprocess owned by one outbound Foreman message."""

    def __init__(
        self, local_port: int, sender: str, thread_id: str, correlation_id: str
    ) -> None:
        self.local_port = local_port
        self.sender = sender
        self.thread_id = thread_id
        self.correlation_id = correlation_id
        self.process: subprocess.Popen[str] | None = None
        self.public_url: str | None = None
        self.logs: queue.Queue[str] = queue.Queue()
        self.log_thread: threading.Thread | None = None

    def _read_logs(self) -> None:
        if self.process is None or self.process.stdout is None:
            return
        for line in self.process.stdout:
            self.logs.put(line.rstrip("\n"))

    def start(self) -> str:
        executable = shutil.which(os.environ.get("FOREMAN_NGROK_BIN", "ngrok"))
        if executable is None:
            raise ForemanError("ngrok is not installed or not on PATH")
        name = f"foreman-{_agent_slug(self.sender)}-{self.correlation_id[:12]}"
        metadata = json.dumps(
            {
                "owner": "foreman-skill",
                "agent": self.sender,
                "thread_id": self.thread_id,
                "correlation_id": self.correlation_id,
            },
            separators=(",", ":"),
        )
        command = [
            executable,
            "http",
            f"http://127.0.0.1:{self.local_port}",
            "--inspect=false",
            "--log=stdout",
            "--log-format=json",
            "--log-level=info",
            f"--name={name}",
            f"--metadata={metadata}",
        ]
        try:
            self.process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            raise ForemanError("Could not start the agent-owned ngrok process") from exc
        self.log_thread = threading.Thread(target=self._read_logs, daemon=True)
        self.log_thread.start()

        deadline = time.monotonic() + _ngrok_start_timeout()
        error_code: str | None = None
        while time.monotonic() < deadline:
            if self.process.poll() is not None and self.logs.empty():
                break
            try:
                line = self.logs.get(timeout=0.25)
            except queue.Empty:
                continue
            public_url = _ngrok_public_url(line)
            if public_url:
                self.public_url = public_url.rstrip("/")
                return self.public_url
            match = re.search(r"ERR_NGROK_\d+", line)
            if match:
                error_code = match.group(0)

        self.stop()
        if error_code:
            raise ForemanError(
                f"ngrok could not create the callback endpoint ({error_code})"
            )
        raise ForemanError(
            "ngrok did not provide a callback endpoint before its startup deadline"
        )

    def assert_running(self) -> None:
        if self.process is None or self.process.poll() is not None:
            raise ForemanError(
                "The agent-owned ngrok tunnel stopped before Foreman replied"
            )

    def stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log_thread is not None:
            self.log_thread.join(timeout=1)
        if self.process.stdout is not None:
            self.process.stdout.close()


def _emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))


def _dispatch(
    payload: dict[str, Any],
    *,
    title: str | None,
    wait: bool,
    dry_run: bool,
    store: ThreadStore,
) -> dict[str, Any]:
    thread_id = payload["thread_id"]
    correlation_id = payload["correlation_id"]
    waiter: CallbackWaiter | None = None
    tunnel: NgrokTunnel | None = None
    callback_path: str | None = None
    if wait:
        callback_path = _callback_path(payload["from"], thread_id, correlation_id)
        if dry_run:
            payload["reply_to"] = "https://agent-owned-ngrok.invalid" + callback_path

    if dry_run:
        return {
            "dry_run": True,
            "thread_id": thread_id,
            "correlation_id": correlation_id,
            "envelope": payload,
        }

    store.update(
        thread_id,
        title=title,
        correlation_id=correlation_id,
        callback_state="starting" if wait else "not_requested",
    )

    dispatch_attempted = False
    acknowledged = False
    try:
        if wait and callback_path is not None:
            waiter = CallbackWaiter(callback_path, thread_id, correlation_id)
            waiter.start()
            tunnel = NgrokTunnel(
                waiter.port, payload["from"], thread_id, correlation_id
            )
            payload["reply_to"] = tunnel.start() + callback_path
            store.update(thread_id, callback_state="waiting")
        dispatch_attempted = True
        status, acknowledgement = _post_json(payload)
        acknowledged = True

        response: dict[str, Any] = {
            "accepted": 200 <= status < 300,
            "http_status": status,
            "thread_id": thread_id,
            "correlation_id": correlation_id,
        }
        if acknowledgement is not None:
            safe_ack = {
                key: acknowledgement[key]
                for key in ("ok", "thread_id", "correlation_id", "error")
                if key in acknowledgement
            }
            if safe_ack:
                response["acknowledgement"] = safe_ack

        if waiter is not None and tunnel is not None:
            callback = waiter.wait(tunnel.assert_running)
            store.update(
                thread_id,
                callback_state="completed" if callback["ok"] else "error",
            )
            response["callback"] = callback
        return response
    except Exception:
        failure_state = (
            "callback_failed"
            if acknowledged
            else "dispatch_unknown" if dispatch_attempted else "setup_failed"
        )
        store.update(
            thread_id,
            callback_state=failure_state,
        )
        raise
    finally:
        if tunnel is not None:
            tunnel.stop()
        if waiter is not None:
            waiter.stop()


def _should_wait(wait: bool | None) -> bool:
    if wait is not None:
        return wait
    return False


def start_thread(
    title: str | None,
    task: str,
    context: dict[str, Any] | None = None,
    *,
    sender: str = "Codex",
    wait: bool | None = None,
    dry_run: bool = False,
    store: ThreadStore | None = None,
) -> dict[str, Any]:
    if not task.strip():
        raise ForemanError("task must not be empty")
    thread_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())
    payload: dict[str, Any] = {
        "from": sender,
        "thread_id": thread_id,
        "correlation_id": correlation_id,
        "task": task,
        "context": context or {},
    }
    if title:
        payload["title"] = title
    return _dispatch(
        payload,
        title=title,
        wait=_should_wait(wait),
        dry_run=dry_run,
        store=store or ThreadStore(),
    )


def message(
    thread_id: str,
    task: str,
    context: dict[str, Any] | None = None,
    *,
    sender: str = "Codex",
    wait: bool | None = None,
    dry_run: bool = False,
    store: ThreadStore | None = None,
) -> dict[str, Any]:
    thread_id = _valid_uuid(thread_id, "thread_id")
    if not task.strip():
        raise ForemanError("task must not be empty")
    payload = {
        "from": sender,
        "thread_id": thread_id,
        "correlation_id": str(uuid.uuid4()),
        "task": task,
        "context": context or {},
    }
    return _dispatch(
        payload,
        title=None,
        wait=_should_wait(wait),
        dry_run=dry_run,
        store=store or ThreadStore(),
    )


def close(
    thread_id: str,
    *,
    sender: str = "Codex",
    dry_run: bool = False,
    store: ThreadStore | None = None,
) -> dict[str, Any]:
    thread_id = _valid_uuid(thread_id, "thread_id")
    correlation_id = str(uuid.uuid4())
    payload = {
        "thread_id": thread_id,
        "action": "close",
        "from": sender,
        "correlation_id": correlation_id,
    }
    if dry_run:
        return {
            "dry_run": True,
            "thread_id": thread_id,
            "correlation_id": correlation_id,
            "envelope": payload,
        }
    active_store = store or ThreadStore()
    status, _acknowledgement = _post_json(payload)
    active_store.update(
        thread_id,
        status="closed",
        correlation_id=correlation_id,
        callback_state="not_requested",
    )
    return {
        "accepted": 200 <= status < 300,
        "http_status": status,
        "thread_id": thread_id,
        "correlation_id": correlation_id,
        "closed": True,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--from",
        dest="sender",
        default=os.environ.get("FOREMAN_AGENT_NAME", "Codex"),
        help="sending agent name (default: FOREMAN_AGENT_NAME or Codex)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    start_parser = subparsers.add_parser("start", help="start a new Foreman thread")
    start_parser.add_argument("--title")
    start_parser.add_argument("--task", required=True)
    start_parser.add_argument("--context-json")
    start_wait = start_parser.add_mutually_exclusive_group()
    start_wait.add_argument("--wait", dest="wait", action="store_true")
    start_wait.add_argument("--no-wait", dest="wait", action="store_false")
    start_parser.set_defaults(wait=None)
    start_parser.add_argument("--dry-run", action="store_true")

    message_parser = subparsers.add_parser(
        "message", help="continue an existing Foreman thread"
    )
    message_parser.add_argument("--thread-id", required=True)
    message_parser.add_argument("--task", required=True)
    message_parser.add_argument("--context-json")
    message_wait = message_parser.add_mutually_exclusive_group()
    message_wait.add_argument("--wait", dest="wait", action="store_true")
    message_wait.add_argument("--no-wait", dest="wait", action="store_false")
    message_parser.set_defaults(wait=None)
    message_parser.add_argument("--dry-run", action="store_true")

    close_parser = subparsers.add_parser("close", help="close a Foreman thread")
    close_parser.add_argument("--thread-id", required=True)
    close_parser.add_argument("--dry-run", action="store_true")

    subparsers.add_parser("threads", help="list locally stored Foreman threads")
    return parser


def main() -> int:
    args = _parser().parse_args()
    if not args.sender.strip():
        raise ForemanError("sender name must not be empty")
    if args.command == "start":
        result = start_thread(
            args.title,
            args.task,
            _context(args.context_json),
            sender=args.sender,
            wait=args.wait,
            dry_run=args.dry_run,
        )
    elif args.command == "message":
        result = message(
            args.thread_id,
            args.task,
            _context(args.context_json),
            sender=args.sender,
            wait=args.wait,
            dry_run=args.dry_run,
        )
    elif args.command == "close":
        result = close(
            args.thread_id,
            sender=args.sender,
            dry_run=args.dry_run,
        )
    else:
        result = {"threads": ThreadStore().list()}
    _emit(result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ForemanError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(2)
