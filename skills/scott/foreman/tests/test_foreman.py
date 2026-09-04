#!/usr/bin/env python3
"""Regression and opt-in live tests for the Foreman skill."""

from __future__ import annotations

import http.client
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from unittest import mock


SKILL_ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = SKILL_ROOT / "scripts" / "foreman.py"
MODULE_SPEC = importlib.util.spec_from_file_location("foreman_under_test", HELPER_PATH)
if MODULE_SPEC is None or MODULE_SPEC.loader is None:  # pragma: no cover
    raise RuntimeError("Could not load Foreman helper")
foreman = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = foreman
MODULE_SPEC.loader.exec_module(foreman)


def _uuid() -> str:
    return str(uuid.uuid4())


def _callback_payload(thread_id: str, correlation_id: str, result: str = "ok"):
    return {
        "ok": True,
        "thread_id": thread_id,
        "correlation_id": correlation_id,
        "result": result,
        "error": None,
    }


def _local_post(port: int, path: str, payload, content_type="application/json"):
    body = (
        payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    )
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(
            "POST",
            path,
            body=body,
            headers={"Content-Type": content_type, "Content-Length": str(len(body))},
        )
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


class FakeResponse:
    def __init__(self, status=202, payload=None):
        self.status = status
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        if self.payload is None:
            return b""
        return json.dumps(self.payload).encode("utf-8")


class ValidationTests(unittest.TestCase):
    def test_https_validation_rejects_insecure_or_embedded_credentials(self):
        with self.assertRaises(foreman.ForemanError):
            foreman._https_url("http://example.test", "test URL")
        with self.assertRaises(foreman.ForemanError):
            foreman._https_url("https://user:pass@example.test", "test URL")
        self.assertEqual(
            foreman._https_url("https://example.test/path", "test URL"),
            "https://example.test/path",
        )

    def test_uuid_and_context_validation(self):
        value = _uuid()
        self.assertEqual(foreman._valid_uuid(value, "thread_id"), value)
        with self.assertRaises(foreman.ForemanError):
            foreman._valid_uuid("not-a-uuid", "thread_id")
        self.assertEqual(foreman._context('{"a":1}'), {"a": 1})
        with self.assertRaises(foreman.ForemanError):
            foreman._context("[]")

    def test_credentials_are_runtime_only_and_required(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(foreman.ForemanError, "runtime secret"):
                foreman._credentials()

    def test_authorization_header_and_tls_context_are_used(self):
        captured = {}

        def fake_urlopen(request, **kwargs):
            captured["request"] = request
            captured["kwargs"] = kwargs
            return FakeResponse(202, {"ok": True})

        environment = {
            "FOREMAN_WEBHOOK_URL": "https://example.test/webhook",
            "FOREMAN_WEBHOOK_KEY": "synthetic-test-key",
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            with mock.patch.object(foreman.urllib.request, "urlopen", fake_urlopen):
                status, body = foreman._post_json({"task": "synthetic"})

        self.assertEqual(status, 202)
        self.assertEqual(body, {"ok": True})
        self.assertEqual(
            captured["request"].get_header("Authorization"),
            "Bearer synthetic-test-key",
        )
        self.assertIsInstance(captured["kwargs"]["context"], foreman.ssl.SSLContext)

    def test_ambiguous_dispatch_error_warns_against_resend(self):
        environment = {
            "FOREMAN_WEBHOOK_URL": "https://example.test/webhook",
            "FOREMAN_WEBHOOK_KEY": "synthetic-test-key",
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            with mock.patch.object(
                foreman.urllib.request,
                "urlopen",
                side_effect=urllib.error.URLError("synthetic failure"),
            ):
                with self.assertRaisesRegex(foreman.ForemanError, "do not assume"):
                    foreman._post_json({"task": "synthetic"})


class ThreadStoreTests(unittest.TestCase):
    def test_store_persists_identifiers_without_task_content(self):
        with tempfile.TemporaryDirectory() as directory:
            store = foreman.ThreadStore(Path(directory))
            thread_id = _uuid()
            correlation_id = _uuid()
            store.update(
                thread_id,
                title="Synthetic title",
                correlation_id=correlation_id,
                callback_state="waiting",
            )
            rows = store.list()
            serialized = store.path.read_text(encoding="utf-8")

            self.assertEqual(rows[0]["thread_id"], thread_id)
            self.assertEqual(rows[0]["last_correlation_id"], correlation_id)
            self.assertNotIn("task", serialized.lower())
            self.assertEqual(stat.S_IMODE(store.root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(store.path.stat().st_mode), 0o600)

    def test_start_message_and_close_dry_runs_preserve_continuity(self):
        with tempfile.TemporaryDirectory() as directory:
            store = foreman.ThreadStore(Path(directory))
            started = foreman.start_thread(
                "Synthetic",
                "First task",
                {"step": 1},
                sender="Codex Test",
                wait=True,
                dry_run=True,
                store=store,
            )
            continued = foreman.message(
                started["thread_id"],
                "Second task",
                {"step": 2},
                sender="Codex Test",
                wait=True,
                dry_run=True,
                store=store,
            )
            closed = foreman.close(
                started["thread_id"],
                sender="Codex Test",
                dry_run=True,
                store=store,
            )

            self.assertEqual(started["thread_id"], continued["thread_id"])
            self.assertEqual(started["thread_id"], closed["thread_id"])
            self.assertNotEqual(started["correlation_id"], continued["correlation_id"])
            self.assertNotEqual(continued["correlation_id"], closed["correlation_id"])
            self.assertIn("/foreman/codex-test/", started["envelope"]["reply_to"])


class CallbackWaiterTests(unittest.TestCase):
    def setUp(self):
        self.thread_id = _uuid()
        self.correlation_id = _uuid()
        self.path = foreman._callback_path(
            "Codex Test", self.thread_id, self.correlation_id
        )
        self.waiter = foreman.CallbackWaiter(
            self.path, self.thread_id, self.correlation_id
        )
        self.waiter.start()

    def tearDown(self):
        self.waiter.stop()

    def test_rejects_wrong_path_content_type_json_and_ids(self):
        valid = _callback_payload(self.thread_id, self.correlation_id)
        self.assertEqual(_local_post(self.waiter.port, "/wrong", valid), 404)
        self.assertEqual(
            _local_post(self.waiter.port, self.path, valid, "text/plain"), 415
        )
        self.assertEqual(_local_post(self.waiter.port, self.path, b"{"), 400)
        wrong_ids = _callback_payload(_uuid(), self.correlation_id)
        self.assertEqual(_local_post(self.waiter.port, self.path, wrong_ids), 409)
        self.assertFalse(self.waiter.event.is_set())

    def test_accepts_only_the_matching_correlated_callback(self):
        payload = _callback_payload(self.thread_id, self.correlation_id, "matched")
        self.assertEqual(_local_post(self.waiter.port, self.path, payload), 202)
        self.assertTrue(self.waiter.event.wait(2))
        self.assertEqual(self.waiter.wait(), payload)

    def test_two_agents_receive_separate_concurrent_callbacks(self):
        other_thread = _uuid()
        other_correlation = _uuid()
        other_path = foreman._callback_path(
            "Claude Test", other_thread, other_correlation
        )
        other = foreman.CallbackWaiter(other_path, other_thread, other_correlation)
        other.start()
        try:
            self.assertNotEqual(self.waiter.port, other.port)
            first = _callback_payload(
                self.thread_id, self.correlation_id, "codex-result"
            )
            second = _callback_payload(other_thread, other_correlation, "claude-result")
            statuses = []
            workers = [
                threading.Thread(
                    target=lambda: statuses.append(
                        _local_post(self.waiter.port, self.path, first)
                    )
                ),
                threading.Thread(
                    target=lambda: statuses.append(
                        _local_post(other.port, other_path, second)
                    )
                ),
            ]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(5)

            self.assertEqual(sorted(statuses), [202, 202])
            self.assertTrue(self.waiter.event.wait(2))
            self.assertTrue(other.event.wait(2))
            self.assertEqual(self.waiter.wait()["result"], "codex-result")
            self.assertEqual(other.wait()["result"], "claude-result")
        finally:
            other.stop()


class NgrokTests(unittest.TestCase):
    def test_ngrok_log_parser_accepts_json_and_logfmt(self):
        self.assertEqual(
            foreman._ngrok_public_url(
                '{"msg":"started tunnel","url":"https://one.example.test"}'
            ),
            "https://one.example.test",
        )
        self.assertEqual(
            foreman._ngrok_public_url(
                'lvl=info msg="started endpoint" url=https://two.example.test'
            ),
            "https://two.example.test",
        )
        self.assertIsNone(foreman._ngrok_public_url('{"msg":"heartbeat"}'))

    def test_tunnel_uses_owned_process_and_stops_only_that_process(self):
        class FakeProcess:
            def __init__(self):
                self.stdout = io.StringIO(
                    '{"msg":"started tunnel","url":"https://owned.example.test"}\n'
                )
                self.returncode = None
                self.terminated = False
                self.killed = False

            def poll(self):
                return self.returncode

            def terminate(self):
                self.terminated = True
                self.returncode = 0

            def wait(self, timeout=None):
                return self.returncode

            def kill(self):
                self.killed = True
                self.returncode = -9

        fake_process = FakeProcess()
        captured = {}

        def fake_popen(command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs
            return fake_process

        tunnel = foreman.NgrokTunnel(49152, "Codex Test", _uuid(), _uuid())
        with mock.patch.object(foreman.shutil, "which", return_value="/bin/ngrok"):
            with mock.patch.object(foreman.subprocess, "Popen", fake_popen):
                self.assertEqual(tunnel.start(), "https://owned.example.test")
                tunnel.stop()

        self.assertIn("http://127.0.0.1:49152", captured["command"])
        self.assertIn("--inspect=false", captured["command"])
        self.assertTrue(fake_process.terminated)
        self.assertFalse(fake_process.killed)


class DispatchLifecycleTests(unittest.TestCase):
    def test_waiting_dispatch_builds_reply_to_and_cleans_owned_resources(self):
        thread_id = _uuid()
        correlation_id = _uuid()
        payload = {
            "from": "Codex Test",
            "thread_id": thread_id,
            "correlation_id": correlation_id,
            "task": "Synthetic",
            "context": {},
        }
        callback = _callback_payload(thread_id, correlation_id, "finished")
        waiter = mock.Mock()
        waiter.port = 49152
        waiter.wait.return_value = callback
        tunnel = mock.Mock(spec=foreman.NgrokTunnel)
        tunnel.start.return_value = "https://owned.example.test"
        captured = {}

        def fake_post(envelope):
            captured.update(envelope)
            return 202, {
                "ok": True,
                "thread_id": thread_id,
                "correlation_id": correlation_id,
            }

        with tempfile.TemporaryDirectory() as directory:
            store = foreman.ThreadStore(Path(directory))
            with mock.patch.object(
                foreman, "CallbackWaiter", return_value=waiter
            ) as waiter_factory:
                with mock.patch.object(
                    foreman, "NgrokTunnel", return_value=tunnel
                ) as tunnel_factory:
                    with mock.patch.object(foreman, "_post_json", fake_post):
                        response = foreman._dispatch(
                            payload,
                            title="Synthetic",
                            wait=True,
                            dry_run=False,
                            store=store,
                        )

            expected_path = foreman._callback_path(
                "Codex Test", thread_id, correlation_id
            )
            waiter_factory.assert_called_once_with(
                expected_path, thread_id, correlation_id
            )
            tunnel_factory.assert_called_once_with(
                49152, "Codex Test", thread_id, correlation_id
            )
            self.assertEqual(
                captured["reply_to"], "https://owned.example.test" + expected_path
            )
            self.assertEqual(response["callback"], callback)
            self.assertEqual(store.list()[0]["last_callback_state"], "completed")
            tunnel.stop.assert_called_once()
            waiter.stop.assert_called_once()


@unittest.skipUnless(
    os.environ.get("FOREMAN_TEST_LIVE_NGROK") == "1",
    "set FOREMAN_TEST_LIVE_NGROK=1 to exercise a real ngrok callback",
)
class LiveNgrokTests(unittest.TestCase):
    def test_real_public_callback_round_trip_and_cleanup(self):
        thread_id = _uuid()
        correlation_id = _uuid()
        path = foreman._callback_path("Codex Live Test", thread_id, correlation_id)
        payload = _callback_payload(thread_id, correlation_id, "live-ngrok-ok")
        waiter = foreman.CallbackWaiter(path, thread_id, correlation_id)
        tunnel = None
        try:
            waiter.start()
            tunnel = foreman.NgrokTunnel(
                waiter.port, "Codex Live Test", thread_id, correlation_id
            )
            public_url = tunnel.start()
            request = urllib.request.Request(
                public_url + path,
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(
                request, timeout=30, context=foreman._tls_context()
            ) as response:
                self.assertEqual(response.status, 202)
            self.assertEqual(waiter.wait(tunnel.assert_running), payload)
        finally:
            if tunnel is not None:
                tunnel.stop()
            waiter.stop()
        self.assertIsNotNone(tunnel)
        self.assertIsNotNone(tunnel.process)
        self.assertIsNotNone(tunnel.process.poll())


@unittest.skipUnless(
    os.environ.get("FOREMAN_TEST_LIVE") == "1",
    "set FOREMAN_TEST_LIVE=1 with runtime secrets to contact Foreman",
)
class LiveForemanTests(unittest.TestCase):
    def test_start_follow_up_correlated_responses_and_close(self):
        if not os.environ.get("FOREMAN_WEBHOOK_URL") or not os.environ.get(
            "FOREMAN_WEBHOOK_KEY"
        ):
            self.fail("live Foreman test requested without runtime credentials")

        thread_id = _uuid()
        first_correlation = _uuid()
        first_nonce = f"foreman-start-{uuid.uuid4().hex}"
        second_nonce = f"foreman-follow-up-{uuid.uuid4().hex}"
        sender = os.environ.get("FOREMAN_AGENT_NAME", "Codex Integration Test")
        closed = False

        with tempfile.TemporaryDirectory() as directory:
            store = foreman.ThreadStore(Path(directory))
            try:
                first_payload = {
                    "from": sender,
                    "thread_id": thread_id,
                    "correlation_id": first_correlation,
                    "title": "Foreman end-to-end integration test",
                    "task": (
                        "This is an automated callback integration test. "
                        f"Reply with this exact nonce: {first_nonce}"
                    ),
                    "context": {"test": "start-response-correlation"},
                }
                first = foreman._dispatch(
                    first_payload,
                    title=first_payload["title"],
                    wait=True,
                    dry_run=False,
                    store=store,
                )
                self.assertTrue(first["accepted"])
                self.assertTrue(first["callback"]["ok"])
                self.assertEqual(first["callback"]["thread_id"], thread_id)
                self.assertEqual(first["callback"]["correlation_id"], first_correlation)
                self.assertIn(first_nonce, str(first["callback"].get("result")))

                second_correlation = _uuid()
                second_payload = {
                    "from": sender,
                    "thread_id": thread_id,
                    "correlation_id": second_correlation,
                    "task": (
                        "Continue this same thread for the second automated test. "
                        f"Reply with this exact nonce: {second_nonce}"
                    ),
                    "context": {"test": "follow-up-continuity"},
                }
                second = foreman._dispatch(
                    second_payload,
                    title=None,
                    wait=True,
                    dry_run=False,
                    store=store,
                )
                self.assertTrue(second["accepted"])
                self.assertTrue(second["callback"]["ok"])
                self.assertEqual(second["callback"]["thread_id"], thread_id)
                self.assertEqual(
                    second["callback"]["correlation_id"], second_correlation
                )
                self.assertNotEqual(first_correlation, second_correlation)
                self.assertIn(second_nonce, str(second["callback"].get("result")))

                closure = foreman.close(thread_id, sender=sender, store=store)
                self.assertTrue(closure["accepted"])
                self.assertTrue(closure["closed"])
                closed = True
            finally:
                if not closed:
                    try:
                        foreman.close(thread_id, sender=sender, store=store)
                    except foreman.ForemanError:
                        pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
