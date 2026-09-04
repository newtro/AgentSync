import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { digestTree } from "../src/lib/fs-tree.js";
import { providerSafeName } from "../src/lib/compiler.js";
import { assertNoUnsafeDeletions, buildRepositoryCandidates, compareSemanticVersions, emptyStableIndex, loadIndex, promoteCandidates, restoreSnapshot, rewrapRelease, rollbackSkill, snapshotIndex, validateStableIndex, validateStableTransition } from "../src/lib/release.js";

function candidate(version, digestChar = "a") {
  const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
  const key = "codex--darwin--default--global";
  return {
    skillId: "scott/example",
    logicalVersion: version,
    sourceCommit: "c".repeat(40),
    lifecycle: { state: "enabled" },
    minimumUpdaterVersion: "0.1.0",
    providerRevision: Number(version.split(".")[0]),
    requiredTargets: [key],
    validation: { security: "passed", targets: { [key]: "passed" } },
    artifacts: {
      [key]: { target, digest: `sha256:${digestChar.repeat(64)}`, payloadDigest: `sha256:${digestChar.repeat(64)}`, path: `artifacts/${version}`, schemaVersion: 1, generatorVersion: "1" }
    }
  };
}

test("promotion is per-skill and provider revisions increase", () => {
  const first = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0"), { ...candidate("1.0.0", "b"), skillId: "scott/other" }] }, { skillIds: ["scott/example"] });
  assert.deepEqual(first.promoted, ["scott/example"]);
  assert.equal(first.index.skills["scott/example"].providerRevision, 1);
  assert.equal(first.index.skills["scott/other"], undefined);
});

test("rollback restores logical content with a forward provider revision", () => {
  const oldRelease = candidate("1.0.0");
  const first = promoteCandidates(emptyStableIndex(), { candidates: [oldRelease] }).index;
  const second = promoteCandidates(first, { candidates: [candidate("2.0.0", "b")] }).index;
  const rolledBack = rollbackSkill(second, "scott/example", { ...oldRelease, providerRevision: 3 });
  assert.equal(rolledBack.skills["scott/example"].logicalVersion, "1.0.0");
  assert.equal(rolledBack.skills["scott/example"].providerRevision, 3);
});

test("rollback accepts a rewrapped immutable stable release without candidate validation fields", () => {
  const first = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  const priorStable = structuredClone(first.skills["scott/example"]);
  const second = promoteCandidates(first, { candidates: [candidate("2.0.0", "b")] }).index;
  const rolledBack = rollbackSkill(second, "scott/example", { skillId: "scott/example", ...priorStable, providerRevision: 3 });
  assert.equal(rolledBack.skills["scott/example"].logicalVersion, "1.0.0");
});

test("snapshot restore reconstructs the set and advances revisions", () => {
  const oldRelease = candidate("1.0.0");
  const first = promoteCandidates(emptyStableIndex(), { candidates: [oldRelease] }).index;
  const snapshot = snapshotIndex(first, "good", "2026-01-01T00:00:00.000Z");
  const second = promoteCandidates(first, { candidates: [candidate("2.0.0", "b")] }).index;
  const restored = restoreSnapshot(second, snapshot, { "scott/example": { ...oldRelease, providerRevision: 3 } });
  assert.equal(restored.skills["scott/example"].logicalVersion, "1.0.0");
  assert.equal(restored.skills["scott/example"].providerRevision, 3);
  assert.deepEqual(snapshot.provenance.generatorVersions, ["1"]);
});

test("snapshot restore retains post-snapshot skills as forward tombstones", () => {
  const oldRelease = candidate("1.0.0");
  const first = promoteCandidates(emptyStableIndex(), { candidates: [oldRelease] }).index;
  const snapshot = snapshotIndex(first, "good");
  const withNew = promoteCandidates(first, { candidates: [{ ...candidate("1.0.0", "b"), skillId: "scott/new" }] }).index;
  const restoredExample = { ...first.skills["scott/example"], providerRevision: 2 };
  const currentNew = withNew.skills["scott/new"];
  const removedNew = { skillId: "scott/new", ...currentNew, providerRevision: 2, lifecycle: { state: "removed", graceDays: 7 } };
  assert.throws(() => restoreSnapshot(withNew, snapshot, { "scott/example": restoredExample }), { code: "SNAPSHOT_REMOVAL" });
  currentNew.promotedAt = "2000-01-01T00:00:00.000Z";
  const restored = restoreSnapshot(withNew, snapshot, { "scott/example": restoredExample }, { "scott/new": removedNew }, new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(restored.skills["scott/new"].lifecycle.state, "removed");
  assert.equal(restored.skills["scott/new"].promotedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(validateStableTransition(withNew, restored), restored);
});

test("promotion rejects incomplete required target coverage", () => {
  const incomplete = candidate("1.0.0");
  incomplete.requiredTargets.push("codex--windows--default--global");
  incomplete.validation.targets["codex--windows--default--global"] = "passed";
  assert.throws(() => promoteCandidates(emptyStableIndex(), { candidates: [incomplete] }), { code: "CANDIDATE_COMPLETENESS" });
});

test("promotion requires a new logical version for changed immutable payload", () => {
  const first = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0", "a")] }).index;
  const changed = candidate("1.0.0", "b");
  changed.providerRevision = 1;
  assert.throws(() => promoteCandidates(first, { candidates: [changed] }), { code: "LOGICAL_VERSION_IMMUTABLE" });
});

test("normal promotion and direct transitions reject logical version downgrade", () => {
  const base = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0", "a")] }).index;
  const downgrade = candidate("0.9.0", "b");
  downgrade.providerRevision = 2;
  assert.throws(() => promoteCandidates(base, { candidates: [downgrade] }), { code: "LOGICAL_VERSION_DOWNGRADE" });
  const next = structuredClone(base);
  next.generation += 1;
  next.skills["scott/example"] = { ...next.skills["scott/example"], logicalVersion: "0.9.0", providerRevision: 2 };
  assert.throws(() => validateStableTransition(base, next), { code: "LOGICAL_VERSION_DOWNGRADE" });
  next.skills["scott/example"].rollbackOf = "1.0.0";
  assert.equal(validateStableTransition(base, next), next);
  assert.equal(compareSemanticVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareSemanticVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareSemanticVersions("1.0.0-alpha-beta", "1.0.0-alpha"), 1);
  assert.equal(compareSemanticVersions("1.0.0-alpha-2", "1.0.0-alpha-1"), 1);
  assert.equal(compareSemanticVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareSemanticVersions("9007199254740993.0.0", "9007199254740992.0.0"), 1);
  assert.equal(compareSemanticVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992"), 1);
});

test("trusted premerge build and promotion reject same-version source mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-premerge-version-"));
  const manifest = { schemaVersion: 1, id: "scott/example", version: "1.0.0", displayName: "Example", description: "Example", files: ["SKILL.md"], targets: { required: [{ harness: "codex", os: "darwin", profile: "default", scope: "global" }] } };
  const firstBuild = await buildRepositoryCandidates([{ manifest, files: new Map([["SKILL.md", Buffer.from("first\n")]]) }], path.join(root, "first"), "a".repeat(40), () => 1);
  const stable = promoteCandidates(emptyStableIndex(), firstBuild).index;
  const candidateBuild = await buildRepositoryCandidates([{ manifest, files: new Map([["SKILL.md", Buffer.from("mutated\n")]]) }], path.join(root, "candidate"), "b".repeat(40), () => stable.skills["scott/example"].providerRevision);
  assert.throws(() => promoteCandidates(stable, candidateBuild), { code: "LOGICAL_VERSION_IMMUTABLE" });
});

test("skill-only commits keep unchanged skill artifacts bound to their original source commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-unchanged-provenance-"));
  const manifest = { schemaVersion: 1, id: "scott/example", version: "1.0.0", displayName: "Example", description: "Example", files: ["SKILL.md"], targets: { required: [{ harness: "codex", os: "darwin", profile: "default", scope: "global" }] } };
  const skill = { manifest, files: new Map([["SKILL.md", Buffer.from("unchanged\n")]]) };
  const commitA = "a".repeat(40);
  const firstBuild = await buildRepositoryCandidates([skill], path.join(root, "first"), commitA);
  const stable = promoteCandidates(emptyStableIndex(), firstBuild).index;
  const secondBuild = await buildRepositoryCandidates([skill], path.join(root, "second"), "b".repeat(40), () => 1, { sourceCommitForSkill: () => commitA });
  const result = promoteCandidates(stable, secondBuild);
  assert.deepEqual(result.promoted, []);
  assert.equal(result.index.skills["scott/example"].sourceCommit, commitA);
});

test("same-version activation semantics cannot change without a version bump", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-activation-version-"));
  const manifest = { schemaVersion: 1, id: "scott/example", version: "1.0.0", displayName: "Example", description: "Example", files: ["SKILL.md"], targets: { required: [{ harness: "codex", os: "darwin", profile: "default", scope: "global" }] } };
  const files = new Map([["SKILL.md", Buffer.from("content\n")]]);
  const commit = "a".repeat(40);
  const first = await buildRepositoryCandidates([{ manifest, files }], path.join(root, "first"), commit);
  const stable = promoteCandidates(emptyStableIndex(), first).index;
  const changed = await buildRepositoryCandidates([{ manifest: { ...manifest, activation: "reload" }, files }], path.join(root, "changed"), commit, () => 1);
  assert.throws(() => promoteCandidates(stable, changed), { code: "LOGICAL_VERSION_IMMUTABLE" });
});

test("stable index loading rejects malformed metadata instead of treating it as empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-index-invalid-"));
  const indexPath = path.join(root, "stable-index.json");
  await writeFile(indexPath, "{}");
  await assert.rejects(loadIndex(indexPath), { code: "INDEX_SCHEMA" });
});

test("stable index rejects a malformed updater release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-updater-index-invalid-"));
  const indexPath = path.join(root, "stable-index.json");
  await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, generation: 0, skills: {}, updater: {} }));
  await assert.rejects(loadIndex(indexPath), { code: "INDEX_UPDATER" });
});

test("stable index rejects malformed compatibility and denied-target metadata", () => {
  const promoted = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  promoted.skills["scott/example"].minimumUpdaterVersion = { bad: true };
  promoted.skills["scott/example"].deniedTargets = ["not-a-target"];
  assert.throws(() => validateStableIndex(promoted), { code: "INDEX_RELEASE" });
});

test("stable index rejects ambiguous promotion timestamps", () => {
  const promoted = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  for (const promotedAt of ["0", "2026", "2026-09-04"]) {
    const malformed = structuredClone(promoted);
    malformed.skills["scott/example"].promotedAt = promotedAt;
    assert.throws(() => validateStableIndex(malformed), { code: "INDEX_RELEASE" });
  }
});

test("stable index rejects prerelease updater compatibility and malformed provenance", () => {
  const promoted = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  promoted.skills["scott/example"].minimumUpdaterVersion = "1.0.0-beta.1";
  assert.throws(() => validateStableIndex(promoted), { code: "INDEX_RELEASE" });
  promoted.skills["scott/example"].minimumUpdaterVersion = "1.0.0";
  promoted.skills["scott/example"].rollbackOf = { bad: true };
  assert.throws(() => validateStableIndex(promoted), { code: "INDEX_RELEASE" });
  delete promoted.skills["scott/example"].rollbackOf;
  promoted.skills["scott/example"].restoredFromSnapshot = [];
  assert.throws(() => validateStableIndex(promoted), { code: "INDEX_RELEASE" });
  assert.throws(() => validateStableIndex({ schemaVersion: 1, generation: 0, skills: {}, updater: { version: "1.0.0-beta.1", artifacts: {} } }), { code: "INDEX_UPDATER" });
});

test("stable index bounds compatibility and rollback versions", () => {
  const promoted = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  promoted.skills["scott/example"].minimumUpdaterVersion = `${"1".repeat(41)}.0.0`;
  assert.throws(() => validateStableIndex(promoted), { code: "INDEX_RELEASE" });
  promoted.skills["scott/example"].minimumUpdaterVersion = "1.0.0";
  promoted.skills["scott/example"].rollbackOf = `${"1".repeat(41)}.0.0`;
  assert.throws(() => validateStableIndex(promoted), { code: "INDEX_RELEASE" });
});

test("published schema binds updater versions to stable semantic versions", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/stable-index.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$defs.release.properties.minimumUpdaterVersion.$ref, "#/$defs/stableSemver");
  assert.equal(schema.$defs.updater.properties.version.$ref, "#/$defs/stableSemver");
  assert.equal(new RegExp(schema.$defs.stableSemver.pattern).test("1.2.3"), true);
  assert.equal(new RegExp(schema.$defs.stableSemver.pattern).test("1.2.3-beta.1"), false);
  for (const version of ["1.0.0-...", "1.0.0-alpha..beta", "1.0.0-01"]) assert.equal(new RegExp(schema.$defs.semver.pattern).test(version), false);
});

test("stable index rejects skill-map keys that could escape managed roots", () => {
  const promoted = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  promoted.skills["a/b/../../../escaped"] = promoted.skills["scott/example"];
  delete promoted.skills["scott/example"];
  assert.throws(() => validateStableIndex(promoted), { code: "INDEX_SKILL_ID" });
});

test("stable releases and updater reject symbolic or abbreviated source revisions", () => {
  const promoted = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  for (const sourceCommit of ["HEAD", "main", "HEAD~1", "working-tree", "abc1234"]) {
    const malformed = structuredClone(promoted);
    malformed.skills["scott/example"].sourceCommit = sourceCommit;
    assert.throws(() => validateStableIndex(malformed), { code: "INDEX_RELEASE" });
  }
  const updater = { schemaVersion: 1, generation: 0, skills: {}, updater: { version: "1.0.0", sourceCommit: "HEAD", artifacts: { darwin: { path: "updater/a", digest: `sha256:${"a".repeat(64)}` }, win32: { path: "updater/b", digest: `sha256:${"b".repeat(64)}` } } } };
  assert.throws(() => validateStableIndex(updater), { code: "INDEX_UPDATER" });
});

test("distribution transitions reject skill deletion, generation reset, and revision downgrade", () => {
  const base = promoteCandidates(emptyStableIndex(), { candidates: [candidate("1.0.0")] }).index;
  const missing = structuredClone(base);
  missing.skills = {};
  assert.throws(() => validateStableTransition(base, missing), { code: "INDEX_SKILL_REMOVED" });
  const changed = structuredClone(base);
  changed.skills["scott/example"].logicalVersion = "2.0.0";
  assert.throws(() => validateStableTransition(base, changed), { code: "PROVIDER_REVISION" });
  const reset = structuredClone(base);
  reset.generation = 0;
  assert.throws(() => validateStableTransition(base, reset), { code: "INDEX_ROLLBACK" });
  const sameVersionMutation = structuredClone(base);
  sameVersionMutation.generation += 1;
  sameVersionMutation.skills["scott/example"].providerRevision += 1;
  sameVersionMutation.skills["scott/example"].lifecycle = { state: "deprecated" };
  assert.throws(() => validateStableTransition(base, sameVersionMutation), { code: "LOGICAL_VERSION_IMMUTABLE" });
});

test("enabled stable skills cannot disappear from canonical source", () => {
  const index = { skills: { "scott/example": { lifecycle: { state: "enabled" } } } };
  assert.throws(() => assertNoUnsafeDeletions([], index), { code: "SOURCE_SKILL_DELETED" });
  index.skills["scott/example"].lifecycle = { state: "removed", graceDays: 7 };
  assert.doesNotThrow(() => assertNoUnsafeDeletions([], index));
});

test("rollback rewrap advances the embedded provider version and digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-rewrap-"));
  const oldPath = "artifacts/scott__example/1.0.0/claude-code--darwin--personal--global";
  const oldRoot = path.join(root, "old", oldPath);
  await mkdir(path.join(oldRoot, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(oldRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "example-id", version: "1.0.0" }));
  await writeFile(path.join(oldRoot, "skillmesh-projection.json"), JSON.stringify({ providerRevision: 1, payloadDigest: "old" }));
  const prior = candidate("1.0.0");
  prior.artifacts = {
    "codex--darwin--default--global": { ...prior.artifacts["codex--darwin--default--global"], path: oldPath, digest: await digestTree(oldRoot) }
  };
  const rewrapped = await rewrapRelease({ priorRelease: prior, buildRoot: path.join(root, "old"), outputRoot: path.join(root, "new"), providerRevision: 3 });
  const artifact = Object.values(rewrapped.artifacts)[0];
  const plugin = JSON.parse(await readFile(path.join(root, "new", artifact.path, ".claude-plugin", "plugin.json"), "utf8"));
  const metadata = JSON.parse(await readFile(path.join(root, "new", artifact.path, "skillmesh-projection.json"), "utf8"));
  assert.equal(plugin.version, "3.0.0");
  assert.equal(artifact.payloadDigest, metadata.payloadDigest);
  assert.notEqual(artifact.digest, prior.artifacts["codex--darwin--default--global"].digest);
});

test("post-merge candidate build quarantines one bad skill without blocking unrelated output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-quarantine-"));
  const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
  const manifest = (id, contains) => ({ schemaVersion: 1, id, version: "1.0.0", displayName: id, description: id, files: ["SKILL.md"], targets: { required: [target] }, smokeTests: [{ type: "file-contains", path: "SKILL.md", contains }] });
  const good = { manifest: manifest("scott/good", "good"), files: new Map([["SKILL.md", Buffer.from("good")]]) };
  const bad = { manifest: manifest("scott/bad", "missing"), files: new Map([["SKILL.md", Buffer.from("bad")]]) };
  const result = await buildRepositoryCandidates([bad, good], root, "commit");
  assert.deepEqual(result.candidates.map((item) => item.skillId), ["scott/good"]);
  assert.deepEqual(result.quarantined.map((item) => item.skillId), ["scott/bad"]);
});

test("a late target failure removes partial same-version candidate output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-partial-quarantine-"));
  const targets = [
    { harness: "codex", os: "darwin", profile: "default", scope: "global" },
    { harness: "codex", os: "windows", profile: "default", scope: "global" }
  ];
  const skill = {
    manifest: {
      schemaVersion: 1, id: "scott/partial", version: "1.0.0", displayName: "Partial", description: "Partial target fixture", files: ["SKILL.md"], targets: { required: targets },
      smokeTests: [{ type: "file-contains", path: "SKILL.md", contains: "missing", match: { os: "windows" } }]
    },
    files: new Map([["SKILL.md", Buffer.from("# Valid first target\n")]])
  };
  const result = await buildRepositoryCandidates([skill], root, "commit", () => 1, { validateClaude: async () => {} });
  assert.equal(result.quarantined[0].skillId, "scott/partial");
  await assert.rejects(readFile(path.join(root, "artifacts", "scott__partial", "1.0.0", "codex--darwin--default--global", "SKILL.md")));
});

test("build quarantines account overlays that conflict in shared Claude Code storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-shared-claude-"));
  const personal = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const organization = { harness: "claude-code", os: "darwin", profile: "organization", scope: "global" };
  const skill = {
    manifest: {
      schemaVersion: 1,
      id: "scott/conflict",
      version: "1.0.0",
      displayName: "Conflict",
      description: "Conflicting shared storage fixture",
      files: ["SKILL.md"],
      overlays: [
        { match: { profile: "personal" }, files: [{ source: "personal.md", destination: "SKILL.md" }] },
        { match: { profile: "organization" }, files: [{ source: "organization.md", destination: "SKILL.md" }] }
      ],
      targets: { required: [personal, organization] }
    },
    files: new Map([
      ["SKILL.md", Buffer.from("# Shared\n")],
      ["personal.md", Buffer.from("# Personal\n")],
      ["organization.md", Buffer.from("# Organization\n")]
    ])
  };
  const result = await buildRepositoryCandidates([skill], root, "commit", () => 1, { validateClaude: async () => {} });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.quarantined.map(({ skillId, code }) => ({ skillId, code })), [{ skillId: "scott/conflict", code: "SHARED_STORAGE_CONFLICT" }]);
});

test("build canonicalizes malformed source frontmatter before strict provider validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-frontmatter-"));
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const skill = {
    manifest: { schemaVersion: 1, id: "scott/frontmatter", version: "1.0.0", displayName: "Frontmatter", description: "Safe generated metadata", files: ["SKILL.md"], targets: { required: [target] } },
    files: new Map([["SKILL.md", Buffer.from("---\nname: [broken\ndescription: malformed\n---\n\n# Body\n")]])
  };
  let validatedPath;
  const result = await buildRepositoryCandidates([skill], root, "commit", () => 1, { validateClaude: async (value) => { validatedPath = value; } });
  assert.equal(result.candidates.length, 1);
  const generated = await readFile(path.join(validatedPath, "skills", providerSafeName("scott/frontmatter", target), "SKILL.md"), "utf8");
  assert.match(generated, new RegExp(`^---\\nname: ${providerSafeName("scott/frontmatter", target)}\\ndescription: "Safe generated metadata"\\n---`));
  assert.doesNotMatch(generated, /\[broken/);
});

test("rebuilding an artifact root removes files deleted from canonical source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-rebuild-clean-"));
  const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
  const withAsset = {
    manifest: { schemaVersion: 1, id: "scott/example", version: "1.0.0", displayName: "Example", description: "Example", files: ["SKILL.md", { source: "asset.bin", kind: "binary" }], targets: { required: [target] } },
    files: new Map([["SKILL.md", Buffer.from("# Example\n")], ["asset.bin", Buffer.from([1, 2, 3])]])
  };
  await buildRepositoryCandidates([withAsset], root, "first");
  const withoutAsset = { ...withAsset, manifest: { ...withAsset.manifest, files: ["SKILL.md"] }, files: new Map([["SKILL.md", Buffer.from("# Example\n")]]) };
  const rebuilt = await buildRepositoryCandidates([withoutAsset], root, "second");
  const artifact = Object.values(rebuilt.candidates[0].artifacts)[0];
  await assert.rejects(readFile(path.join(root, artifact.path, "asset.bin")));
  assert.equal(await digestTree(path.join(root, artifact.path)), artifact.digest);
});

test("restore tombstones propagate through Codex and Claude projections with a forward revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-restore-tombstone-"));
  const targets = [
    { harness: "codex", os: "darwin", profile: "default", scope: "global" },
    { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" }
  ];
  const skill = {
    manifest: { schemaVersion: 1, id: "scott/example", version: "1.0.0", displayName: "Example", description: "Example", files: ["SKILL.md"], targets: { required: targets } },
    files: new Map([["SKILL.md", Buffer.from("# Active\n")]])
  };
  const built = await buildRepositoryCandidates([skill], path.join(root, "old"), "commit", () => 1, { validateClaude: async () => {} });
  const prior = built.candidates[0];
  const removed = await rewrapRelease({ priorRelease: prior, buildRoot: path.join(root, "old"), outputRoot: path.join(root, "new"), providerRevision: 2, tombstone: true, lifecycle: { state: "removed", graceDays: 7 } });
  for (const artifact of Object.values(removed.artifacts)) {
    const artifactRoot = path.join(root, "new", artifact.path);
    const tree = await (await import("../src/lib/fs-tree.js")).readTree(artifactRoot);
    const skillPath = [...tree.keys()].find((file) => file.endsWith("SKILL.md"));
    assert.match(tree.get(skillPath).toString("utf8"), /^---\n[\s\S]*disabled and must not perform/);
    if (artifact.target.harness.startsWith("claude")) assert.equal(JSON.parse(tree.get(".claude-plugin/plugin.json")).version, "2.0.0");
  }
});
