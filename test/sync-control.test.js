import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordSyncAttempt, shouldRunScheduled } from "../src/lib/sync-control.js";

test("scheduled synchronization applies jitter and exponential failure backoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-control-"));
  const now = new Date("2026-01-01T00:00:00Z");
  const first = await recordSyncAttempt({ stateRoot: root, error: new Error("offline"), now, random: () => 0 });
  assert.equal(first.failureCount, 1);
  assert.equal(first.nextAttemptAt, "2026-01-01T00:01:00.000Z");
  assert.equal(await shouldRunScheduled(root, new Date("2026-01-01T00:00:30Z")), false);
  const second = await recordSyncAttempt({ stateRoot: root, error: new Error("offline"), now: new Date("2026-01-01T00:01:00Z"), random: () => 0 });
  assert.equal(second.nextAttemptAt, "2026-01-01T00:03:00.000Z");
  const status = JSON.parse(await readFile(path.join(root, "status.json"), "utf8"));
  assert.equal(status.syncAttempt.state, "failed");
});
