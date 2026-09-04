---
name: foreman
description: Send tasks to Foreman, Scott's coordinating Grok Bot agent, continue an existing Foreman thread, wait for a correlated callback, or close a Foreman thread. Use when Scott asks Codex to contact, delegate to, hand work to, follow up with, or close work with Foreman; do not use for general Grok or xAI questions.
---

# Foreman

Foreman is Scott's persistent coordinating agent on Grok Bot. Communicate with Foreman only through the configured webhook. Do not invent or substitute chat, email, GitHub, browser automation, or another delivery channel.

Use `scripts/foreman.py`, resolved relative to this file, for all protocol operations. The helper generates UUIDs, sends exactly one task per request, validates callbacks, and stores thread identifiers under the active Codex state directory. Give each harness a distinct `FOREMAN_AGENT_NAME` so Foreman and callback paths identify the actual sender.

## Credential boundary

Require `FOREMAN_WEBHOOK_URL` and `FOREMAN_WEBHOOK_KEY` to be injected at runtime by the configured secret runner. The helper sends the key as `Authorization: Bearer <key>`.

- Never place either value in this skill, another file, a task body, context, command output, or source control.
- Never print, inspect, or retrieve the values into model context.
- When `asm-exec` and the Secrets Manager integration are available, use runtime dynamic references rather than calling a secret-read API directly.
- If the variables are unavailable, ask Scott once to configure them in the secret store; do not ask him to paste them into chat.
- Do not send passwords, tokens, API keys, or other secrets in `task` or `context`.

## Operations

Resolve the helper path from this skill directory, then run one of:

```bash
python3 scripts/foreman.py start --title "<title>" --task "<plain-English task>" --context-json '<JSON object>'
python3 scripts/foreman.py message --thread-id "<thread UUID>" --task "<follow-up>" --context-json '<JSON object>'
python3 scripts/foreman.py close --thread-id "<thread UUID>"
python3 scripts/foreman.py threads
```

`start` creates and persists a new `thread_id`. Reuse that exact ID with `message`; a new ID means a fresh conversation. Every outbound message receives a new `correlation_id`. Use the IDs returned by the helper rather than inventing replacements outside it.

Give Foreman a clear outcome, the context needed to act, relevant constraints, and the expected deliverable. `task` is free text and is not restricted to a domain or enum. Put a title only on the first message.

## Replies

Omit `--wait` for fire-and-forget work. When the result is needed to continue, add `--wait`. The sending invocation must own its callback resources:

1. The helper binds a new loopback listener on an ephemeral port.
2. It starts a new ngrok subprocess for that listener without changing ngrok's account configuration.
3. It sends a random HTTPS endpoint with an agent-, thread-, and correlation-specific path as `reply_to`.
4. It accepts only a callback whose path, `thread_id`, and `correlation_id` all match.
5. It stops only the listener and ngrok subprocess it created after the matching callback or an error.

Never reuse another agent's callback URL, share a fixed callback port, kill unrelated ngrok processes, or modify ngrok authentication from this skill. `ngrok` must already be installed and authenticated by Scott. Separate waiting invocations can run concurrently because each owns a unique listener, endpoint, and callback path.

Run a waiting command as a yielded process and poll it at reasonable intervals so Scott continues to receive progress updates. Treat a transport acknowledgement as dispatch only, never as task completion. Do not retry an ambiguous dispatch with a new correlation ID; the original request may still be running.

Expected callback:

```json
{
  "ok": true,
  "thread_id": "...",
  "correlation_id": "...",
  "result": "answer or summary",
  "error": null
}
```

Match the reply on both IDs. Report `error` when `ok` is false. Preserve the thread for follow-ups until the work is genuinely finished.

## Closing

Close a thread when its delegated work and any necessary follow-ups are complete:

```bash
python3 scripts/foreman.py close --thread-id "<thread UUID>"
```

Closing sends the protocol's `action: close` envelope and marks the stored thread closed only after the webhook acknowledges it.

## Validation

Use `tests/test_foreman.py` for regression checks. Run the ordinary suite without credentials. Set `FOREMAN_TEST_LIVE_NGROK=1` to add a real public callback round trip. Set `FOREMAN_TEST_LIVE=1` only when the runtime secret variables are already injected; that test starts a Foreman thread, verifies two correlated responses on the same thread, and closes it.
