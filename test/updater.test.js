import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { digestTree } from "../src/lib/fs-tree.js";
import { synchronize, withEndpointLock } from "../src/lib/updater.js";
import { providerSafeName } from "../src/lib/compiler.js";

function installSlug(f) {
  const { harness, os, profile, scope } = f.enrollment;
  return providerSafeName("scott/example", { harness, os, profile, scope });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-update-"));
  const distributionRoot = path.join(root, "distribution");
  const artifactPath = "artifacts/scott__example/1.0.0/codex--darwin--default--global";
  const artifactRoot = path.join(distributionRoot, artifactPath);
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, "SKILL.md"), "# Stable\n");
  const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
  const payloadDigest = await digestTree(artifactRoot);
  await writeFile(path.join(artifactRoot, "skillmesh-projection.json"), JSON.stringify({ schemaVersion: 1, generatorVersion: "1", logicalSkillId: "scott/example", logicalVersion: "1.0.0", providerRevision: 1, sourceCommit: "commit", lifecycle: { state: "enabled" }, targetKey: "codex--darwin--default--global", payloadDigest, executableFiles: [] }));
  const digest = await digestTree(artifactRoot);
  const index = { skills: { "scott/example": { logicalVersion: "1.0.0", providerRevision: 1, sourceCommit: "commit", lifecycle: { state: "enabled" }, artifacts: {
    "codex--darwin--default--global": { target, digest, path: artifactPath, schemaVersion: 1, generatorVersion: "1", payloadDigest }
  } } } };
  const enrollment = { id: "mac|codex|default|global|-", machine: "mac", harness: "codex", profile: "default", scope: "global", os: "darwin", mode: "direct", installRoot: path.join(root, "skills") };
  return { root, distributionRoot, index, enrollment };
}

async function refreshArtifact(f) {
  const artifact = Object.values(f.index.skills["scott/example"].artifacts)[0];
  const artifactRoot = path.join(f.distributionRoot, artifact.path);
  const metadataPath = path.join(artifactRoot, "skillmesh-projection.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.logicalVersion = f.index.skills["scott/example"].logicalVersion;
  metadata.providerRevision = f.index.skills["scott/example"].providerRevision;
  metadata.lifecycle = f.index.skills["scott/example"].lifecycle;
  metadata.targetKey = `${artifact.target.harness}--${artifact.target.os}--${artifact.target.profile}--${artifact.target.scope}`;
  metadata.payloadDigest = await digestTree(artifactRoot, { exclude: new Set(["skillmesh-projection.json"]) });
  await writeFile(metadataPath, JSON.stringify(metadata));
  artifact.payloadDigest = metadata.payloadDigest;
  artifact.digest = await digestTree(artifactRoot);
}

test("sync installs a verified direct artifact atomically", async () => {
  const f = await fixture();
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot: path.join(f.root, "state") });
  assert.equal(await readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md"), "utf8"), "# Stable\n");
  assert.equal(statuses[0].state, "installed");
  assert.equal(statuses[0].active, "unknown");
});

test("sync does not activate a projection whose declared runtime is unavailable", async () => {
  const f = await fixture();
  const artifactRoot = path.join(f.distributionRoot, Object.values(f.index.skills["scott/example"].artifacts)[0].path);
  const metadataPath = path.join(artifactRoot, "skillmesh-projection.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.requiredRuntimes = ["python"];
  await writeFile(metadataPath, JSON.stringify(metadata));
  await refreshArtifact(f);
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot: path.join(f.root, "state"), runtimeAvailable: async () => false });
  assert.equal(statuses[0].state, "failed");
  assert.match(statuses[0].error, /Required runtimes are unavailable/);
  await assert.rejects(readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md")));
});

test("sync preserves drift before restoring stable content", async () => {
  const f = await fixture();
  const stateRoot = path.join(f.root, "state");
  await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot, now: new Date("2026-01-01T00:00:00Z") });
  await writeFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md"), "local edit\n");
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot, now: new Date("2026-01-02T00:00:00Z") });
  assert.equal(statuses[0].state, "drifted");
  assert.equal(statuses[0].recoveredTo, "stable");
  const preserved = path.join(stateRoot, "drift", "2026-01-02T00-00-00-000Z", encodeURIComponent(f.enrollment.id), installSlug(f), "tree", "SKILL.md");
  assert.equal(await readFile(preserved, "utf8"), "local edit\n");
  assert.equal(await readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md"), "utf8"), "# Stable\n");
});

test("provider-managed endpoints are never falsely reported installed", async () => {
  const f = await fixture();
  const provider = { ...f.enrollment, id: "mac|claude-desktop|personal|global|-", harness: "claude-desktop", profile: "personal", mode: "assisted", installRoot: null };
  const target = { harness: "claude-desktop", os: "darwin", profile: "personal", scope: "global" };
  f.index.skills["scott/example"].artifacts = { "claude-desktop--darwin--personal--global": { ...Object.values(f.index.skills["scott/example"].artifacts)[0], target } };
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [provider], stateRoot: path.join(f.root, "state") });
  assert.equal(statuses[0].state, "assisted-action-required");
});

test("an empty stable index does not invoke a provider marketplace", async () => {
  const f = await fixture();
  const provider = { ...f.enrollment, harness: "claude-code", profile: "personal", mode: "marketplace", installRoot: null };
  let calls = 0;
  const statuses = await synchronize({
    distributionRoot: f.distributionRoot,
    distributionRepo: "repo",
    index: { skills: {} },
    enrollments: [provider],
    stateRoot: path.join(f.root, "state"),
    providerSync: async () => { calls += 1; return []; }
  });
  assert.equal(calls, 0);
  assert.deepEqual(statuses, []);
});

test("one broken skill does not prevent an unrelated skill from converging", async () => {
  const f = await fixture();
  f.index.skills["scott/broken"] = structuredClone(f.index.skills["scott/example"]);
  f.index.skills["scott/broken"].artifacts["codex--darwin--default--global"].digest = `sha256:${"0".repeat(64)}`;
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot: path.join(f.root, "state") });
  assert.equal(statuses.find((item) => item.skillId === "scott/example").state, "installed");
  assert.equal(statuses.find((item) => item.skillId === "scott/broken").state, "failed");
});

test("denied and newer-updater targets are reported without installation", async () => {
  const f = await fixture();
  f.index.skills["scott/denied"] = { ...structuredClone(f.index.skills["scott/example"]), deniedTargets: ["codex--darwin--default--global"], artifacts: {} };
  f.index.skills["scott/example"].minimumUpdaterVersion = "99.0.0";
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot: path.join(f.root, "state") });
  assert.equal(statuses.find((item) => item.skillId === "scott/denied").state, "denied");
  assert.equal(statuses.find((item) => item.skillId === "scott/example").state, "pinned");
});

test("minimum updater comparisons preserve large semantic version precision", async () => {
  const f = await fixture();
  f.index.skills["scott/example"].minimumUpdaterVersion = "9007199254740993.0.0";
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot: path.join(f.root, "state") });
  assert.equal(statuses[0].state, "pinned");
});

test("a newly denied direct target removes its previously managed copy", async () => {
  const f = await fixture();
  const stateRoot = path.join(f.root, "state");
  await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot });
  const release = f.index.skills["scott/example"];
  release.deniedTargets = ["codex--darwin--default--global"];
  release.artifacts = {};
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot });
  assert.equal(statuses[0].state, "denied");
  await assert.rejects(readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md")));
});

test("removal waits for grace then removes only a managed copy", async () => {
  const f = await fixture();
  const stateRoot = path.join(f.root, "state");
  await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot, now: new Date("2026-01-01T00:00:00Z") });
  const artifactRoot = path.join(f.distributionRoot, Object.values(f.index.skills["scott/example"].artifacts)[0].path);
  await writeFile(path.join(artifactRoot, "SKILL.md"), "# Removed\n\nDisabled.\n");
  f.index.skills["scott/example"].lifecycle = { state: "removed", removeAfter: "2026-01-08T00:00:00Z" };
  await refreshArtifact(f);
  const grace = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot, now: new Date("2026-01-07T00:00:00Z") });
  assert.equal(grace[0].lifecycle, "deprecated");
  assert.match(await readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md"), "utf8"), /Disabled/);
  const removed = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot, now: new Date("2026-01-09T00:00:00Z") });
  assert.equal(removed[0].lifecycle, "removed");
  await assert.rejects(readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md")));
});

test("a removal-due Desktop endpoint receives an exact uninstall action", async () => {
  const f = await fixture();
  const provider = { ...f.enrollment, id: "desktop", harness: "claude-desktop", profile: "personal", mode: "assisted", installRoot: null };
  const target = { harness: "claude-desktop", os: "darwin", profile: "personal", scope: "global" };
  f.index.skills["scott/example"].artifacts = { "claude-desktop--darwin--personal--global": { ...Object.values(f.index.skills["scott/example"].artifacts)[0], target } };
  f.index.skills["scott/example"].lifecycle = { state: "removed", removeAfter: "2026-01-01T00:00:00Z" };
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, distributionRepo: "repo", index: f.index, enrollments: [provider], stateRoot: path.join(f.root, "state"), now: new Date("2026-01-02T00:00:00Z") });
  assert.match(statuses[0].action, /uninstall scott\/example/);
});

test("first sync refuses to overwrite an unmanaged matching directory", async () => {
  const f = await fixture();
  await mkdir(path.join(f.enrollment.installRoot, installSlug(f)), { recursive: true });
  await writeFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md"), "user copy\n");
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot: path.join(f.root, "state") });
  assert.equal(statuses[0].state, "failed");
  assert.equal(await readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md"), "utf8"), "user copy\n");
});

test("state persistence failure restores last-known-good before deleting backup", async (t) => {
  const f = await fixture();
  const stateRoot = path.join(f.root, "state");
  await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot });
  const stateFile = path.join(stateRoot, "installed", encodeURIComponent(f.enrollment.id), "scott__example.json");
  await chmod(stateFile, 0o400);
  t.after(async () => chmod(stateFile, 0o600).catch(() => {}));
  const artifactRoot = path.join(f.distributionRoot, Object.values(f.index.skills["scott/example"].artifacts)[0].path);
  await writeFile(path.join(artifactRoot, "SKILL.md"), "# New\n");
  f.index.skills["scott/example"].logicalVersion = "2.0.0";
  await refreshArtifact(f);
  const statuses = await synchronize({ distributionRoot: f.distributionRoot, index: f.index, enrollments: [f.enrollment], stateRoot });
  assert.equal(statuses[0].state, "failed");
  assert.equal(await readFile(path.join(f.enrollment.installRoot, installSlug(f), "SKILL.md"), "utf8"), "# Stable\n");
});

test("Claude provider removal waits until the configured grace deadline", async () => {
  const f = await fixture();
  const provider = { ...f.enrollment, id: "claude", harness: "claude-code", profile: "personal", mode: "marketplace", installRoot: null };
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  f.index.skills["scott/example"].artifacts = { "claude-code--darwin--personal--global": { ...Object.values(f.index.skills["scott/example"].artifacts)[0], target } };
  f.index.skills["scott/example"].lifecycle = { state: "removed", removeAfter: "2099-01-01T00:00:00Z" };
  let observedState;
  const providerSync = async ({ index }) => {
    observedState = index.skills["scott/example"].lifecycle.state;
    return [{ skillId: "scott/example", state: "installed", active: "unknown" }];
  };
  await synchronize({ distributionRoot: f.distributionRoot, distributionRepo: "repo", index: f.index, enrollments: [provider], stateRoot: path.join(f.root, "state"), providerSync, now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(observedState, "deprecated");
});

test("stale process locks are recovered but live locks block overlap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-lock-"));
  await writeFile(path.join(root, "sync.lock"), JSON.stringify({ pid: 99999999, createdAt: "2000-01-01T00:00:00Z" }));
  assert.equal(await withEndpointLock(root, async () => "recovered", { now: new Date("2026-01-01T00:00:00Z") }), "recovered");
  let release;
  const held = withEndpointLock(root, async () => await new Promise((resolve) => { release = resolve; }));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(withEndpointLock(root, async () => {}), /already running/);
  release();
  await held;
  await writeFile(path.join(root, "sync.lock"), JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00Z" }));
  await assert.rejects(withEndpointLock(root, async () => {}, { now: new Date("2026-01-01T00:00:00Z") }), /already running/);
  const { rm } = await import("node:fs/promises");
  await rm(path.join(root, "sync.lock"));
});
