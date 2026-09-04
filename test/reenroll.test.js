import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { reenroll, retryPendingRetirements } from "../src/lib/reenroll.js";
import { digestTree } from "../src/lib/fs-tree.js";

test("re-enrollment validates the new distribution before atomically switching config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-reenroll-"));
  const stateRoot = path.join(root, "state");
  const oldRepos = path.join(stateRoot, "repos");
  await mkdir(oldRepos, { recursive: true });
  await writeFile(path.join(oldRepos, "old-marker"), "old");
  await writeFile(path.join(stateRoot, "config.json"), JSON.stringify({ sourceRepo: "/old", updaterExecutable: "/managed/skillmesh", enrollments: [{ machine: "mac" }] }));
  const source = path.join(root, "new-source");
  const distribution = path.join(root, "new-distribution");
  await mkdir(source);
  await mkdir(distribution);
  await writeFile(path.join(source, "skillmesh.config.json"), JSON.stringify({ schemaVersion: 1, distributionRepo: distribution }));
  await writeFile(path.join(distribution, "stable-index.json"), JSON.stringify({ schemaVersion: 1, generation: 0, skills: {} }));
  const cloneOrUpdate = async (repo, destination) => {
    await mkdir(destination, { recursive: true });
    if (repo === source) await writeFile(path.join(destination, "skillmesh.config.json"), await readFile(path.join(source, "skillmesh.config.json")));
    if (repo === distribution) await writeFile(path.join(destination, "stable-index.json"), await readFile(path.join(distribution, "stable-index.json")));
  };
  const result = await reenroll(source, { stateRoot, cloneOrUpdate, probeCapabilities: async () => ({ targets: [] }), now: new Date("2026-01-01T00:00:00Z") });
  const config = JSON.parse(await readFile(path.join(stateRoot, "config.json"), "utf8"));
  assert.equal(config.sourceRepo, source);
  assert.equal(config.updaterExecutable, "/managed/skillmesh");
  assert.ok(result.previousRepos);
  assert.equal(result.repositorySwitched, true);
  assert.equal(result.complete, false);
  assert.equal(result.credentialRevocation.state, "assisted-action-required");
  assert.equal(await readFile(path.join(result.previousRepos, "old-marker"), "utf8"), "old");
});

test("re-enrollment retires a managed direct skill absent from the new repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-reenroll-orphan-"));
  const stateRoot = path.join(root, "state");
  const oldDistribution = path.join(stateRoot, "repos", "distribution");
  const installRoot = path.join(root, "installed");
  const destination = path.join(installRoot, "scott__old");
  const enrollment = { id: "mac|codex|default|global|-", machine: "mac", harness: "codex", os: "darwin", profile: "default", scope: "global", mode: "direct", installRoot };
  await mkdir(oldDistribution, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "SKILL.md"), "old managed\n");
  const activeDigest = await digestTree(destination);
  const key = "codex--darwin--default--global";
  await writeFile(path.join(oldDistribution, "stable-index.json"), JSON.stringify({ schemaVersion: 1, generation: 1, skills: { "scott/old": {
    logicalVersion: "1.0.0", sourceCommit: "a".repeat(40), providerRevision: 1, lifecycle: { state: "enabled" }, requiredTargets: [key], deniedTargets: [],
    artifacts: { [key]: { target: { harness: "codex", os: "darwin", profile: "default", scope: "global" }, path: "artifacts/old", digest: `sha256:${"a".repeat(64)}`, payloadDigest: `sha256:${"b".repeat(64)}`, schemaVersion: 1, generatorVersion: "1" } }
  } } }));
  await mkdir(path.join(stateRoot, "installed", encodeURIComponent(enrollment.id)), { recursive: true });
  await writeFile(path.join(stateRoot, "installed", encodeURIComponent(enrollment.id), "scott__old.json"), JSON.stringify({ activeDigest, logicalVersion: "1.0.0" }));
  await writeFile(path.join(stateRoot, "config.json"), JSON.stringify({ sourceRepo: "/old-source", distributionRepo: "/old-distribution", distributionCheckout: oldDistribution, updaterExecutable: "/managed/skillmesh", enrollments: [enrollment] }));

  const source = path.join(root, "new-source");
  const distribution = path.join(root, "new-distribution");
  await mkdir(source);
  await mkdir(distribution);
  await writeFile(path.join(source, "skillmesh.config.json"), JSON.stringify({ schemaVersion: 1, distributionRepo: distribution }));
  await writeFile(path.join(distribution, "stable-index.json"), JSON.stringify({ schemaVersion: 1, generation: 0, skills: {} }));
  const cloneOrUpdate = async (repo, output) => {
    await mkdir(output, { recursive: true });
    if (repo === source) await writeFile(path.join(output, "skillmesh.config.json"), await readFile(path.join(source, "skillmesh.config.json")));
    if (repo === distribution) await writeFile(path.join(output, "stable-index.json"), await readFile(path.join(distribution, "stable-index.json")));
  };
  const result = await reenroll(source, { stateRoot, cloneOrUpdate, probeCapabilities: async () => ({ targets: [] }), now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(result.orphanCleanup[0].lifecycle, "removed");
  await assert.rejects(readFile(path.join(destination, "SKILL.md")));
});

test("sync retries persisted provider retirements until absence is verified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-reenroll-retry-"));
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  const enrollment = { id: "mac|claude-code|personal|global|-", harness: "claude-code", os: "darwin", profile: "personal", scope: "global", mode: "marketplace" };
  const key = "claude-code--darwin--personal--global";
  const index = { schemaVersion: 1, generation: 1, skills: { "scott/old": {
    logicalVersion: "1.0.0", sourceCommit: "a".repeat(40), providerRevision: 1, lifecycle: { state: "removed", removeAfter: "2026-01-01T00:00:00.000Z", emergencyOverride: { approvedBy: "test", reason: "verified retry test", approvedAt: "2026-01-01T00:00:00.000Z" } }, requiredTargets: [], deniedTargets: [key], artifacts: {}
  } } };
  const plan = { id: enrollment.id, enrollment, distributionRepo: "old-repo", distributionCheckout: path.join(root, "old-distribution"), index, lastStatuses: [] };
  const config = { schemaVersion: 1, pendingRetirements: [plan] };
  await writeFile(path.join(stateRoot, "config.json"), JSON.stringify(config));
  const first = await retryPendingRetirements(config, { stateRoot, providerSync: async () => [{ skillId: "scott/old", state: "unknown", installed: "unknown", active: "unknown", lifecycle: "removed" }] });
  assert.equal(first.pendingRetirements.length, 1);
  const second = await retryPendingRetirements(first.config, { stateRoot, providerSync: async () => [{ skillId: "scott/old", state: "removed", installed: null, active: "verified-absent", lifecycle: "removed" }] });
  assert.equal(second.pendingRetirements.length, 0);
  const saved = JSON.parse(await readFile(path.join(stateRoot, "config.json"), "utf8"));
  assert.equal(saved.pendingRetirements, undefined);
});
