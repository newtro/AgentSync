import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { offboardEndpoint, removeNativeSchedule } from "../src/lib/offboard.js";
import { digestTree } from "../src/lib/fs-tree.js";

test("offboarding does not remove unmanaged skill copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-offboard-"));
  const installRoot = path.join(root, "skills");
  await mkdir(path.join(installRoot, "scott__example"), { recursive: true });
  await writeFile(path.join(installRoot, "scott__example", "SKILL.md"), "unmanaged");
  const enrollment = { id: "endpoint", harness: "codex", os: "darwin", profile: "default", scope: "global", mode: "direct", installRoot };
  const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
  const index = { skills: { "scott/example": { artifacts: { "codex--darwin--default--global": { target } } } } };
  const result = await offboardEndpoint({
    config: { enrollments: [enrollment] },
    index,
    stateRoot: path.join(root, "state"),
    removeSchedule: async () => ({ removed: true })
  });
  assert.equal(result.results[0].state, "unknown");
  assert.equal(result.credentialState.state, "assisted-action-required");
  assert.equal(result.complete, false);
  assert.equal(result.configRetained, true);
});

test("offboarding removes managed direct skills even when absent from the current index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-offboard-stale-"));
  const stateRoot = path.join(root, "state");
  const installRoot = path.join(root, "skills");
  const destination = path.join(installRoot, "scott__stale");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "SKILL.md"), "managed");
  const enrollment = { id: "endpoint", harness: "codex", os: "darwin", profile: "default", scope: "global", mode: "direct", installRoot };
  const stateDir = path.join(stateRoot, "installed", encodeURIComponent(enrollment.id));
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "scott__stale.json"), JSON.stringify({ activeDigest: await digestTree(destination) }));
  const result = await offboardEndpoint({
    config: { enrollments: [enrollment] }, index: { skills: {} }, stateRoot,
    removeSchedule: async () => ({ removed: null, complete: true }),
    credentialRevocation: { state: "completed", evidence: "owner-confirmed" }
  });
  assert.equal(result.complete, true);
  assert.equal(result.results[0].state, "removed");
  await assert.rejects(readFile(path.join(destination, "SKILL.md")));
});

test("schedule offboarding queries native state even when its local definition is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-offboard-native-"));
  const calls = [];
  const outcomes = [{ started: true, code: 0 }, { started: true, code: 0 }, { started: true, code: 1 }];
  const result = await removeNativeSchedule({ home: root, nodePlatform: "darwin", runner: async (command, args) => { calls.push([command, ...args]); return outcomes.shift(); } });
  assert.equal(result.complete, true);
  assert.deepEqual(calls.map((call) => call[1]), ["print", "bootout", "print"]);
});

test("offboarding retains config when native schedule removal cannot be confirmed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-offboard-schedule-"));
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, "config.json"), "{}");
  const result = await offboardEndpoint({
    config: { enrollments: [] }, index: { skills: {} }, stateRoot,
    removeSchedule: async () => ({ complete: false, reason: "native deletion failed" })
  });
  assert.equal(result.complete, false);
  assert.equal(result.configRetained, true);
  assert.equal(await readFile(path.join(stateRoot, "config.json"), "utf8"), "{}");
});

test("offboarding retires and verifies the managed Claude marketplace even with no skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-offboard-marketplace-"));
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, "config.json"), "{}");
  let retireMarketplace = false;
  const result = await offboardEndpoint({
    config: { distributionCheckout: "/distribution", distributionRepo: "https://github.com/o/old.git", enrollments: [{ id: "claude", harness: "claude-code", os: "darwin", profile: "personal", scope: "global", mode: "marketplace" }] },
    index: { skills: {} },
    stateRoot,
    providerSync: async (options) => { retireMarketplace = options.retireMarketplace; return [{ skillId: "skillmesh-stable", state: "removed", installed: null, active: "verified-absent" }]; },
    removeSchedule: async () => ({ complete: true }),
    credentialRevocation: { state: "completed", evidence: "owner-confirmed" }
  });
  assert.equal(retireMarketplace, true);
  assert.equal(result.complete, true);
  await assert.rejects(readFile(path.join(stateRoot, "config.json")), { code: "ENOENT" });
});
