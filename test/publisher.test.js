import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDistributionStage, publishDistributionPullRequest, validateDistributionStage, validateSourceUpdaterContract } from "../src/lib/publisher.js";
import { digestTree } from "../src/lib/fs-tree.js";
import { providerSafeName } from "../src/lib/compiler.js";
import { buildRepositoryCandidates, emptyStableIndex, promoteCandidates } from "../src/lib/release.js";

const SOURCE_COMMIT = "c".repeat(40);

async function updaterSource(root, darwin = "#!/bin/sh\nexit 0\n", windows = "@exit /b 0\r\n") {
  await mkdir(path.join(root, "updater", "darwin"), { recursive: true });
  await mkdir(path.join(root, "updater", "win32"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await writeFile(path.join(root, "src", "lib", "version.js"), "export const CURRENT_VERSION = \"0.1.0\";\n");
  await writeFile(path.join(root, "updater", "darwin", "skillmesh"), darwin);
  await writeFile(path.join(root, "updater", "win32", "skillmesh.cmd"), windows);
}

test("distribution stage contains only stable referenced artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-publish-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const buildRoot = path.join(root, "build");
  await mkdir(sourceRoot);
  await mkdir(distributionRoot);
  spawnSync("git", ["init", "-q"], { cwd: sourceRoot });
  spawnSync("git", ["init", "-q"], { cwd: distributionRoot });
  await mkdir(path.join(sourceRoot, "updater", "darwin"), { recursive: true });
  await mkdir(path.join(sourceRoot, "updater", "win32"), { recursive: true });
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await mkdir(path.join(sourceRoot, "src", "lib"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "lib", "version.js"), "export const CURRENT_VERSION = \"0.1.0\";\n");
  await writeFile(path.join(sourceRoot, "updater", "darwin", "skillmesh"), "#!/bin/sh\nexit 0\n");
  await writeFile(path.join(sourceRoot, "updater", "win32", "skillmesh.cmd"), "@exit /b 0\r\n");
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceRoot });
  spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: sourceRoot });
  spawnSync("git", ["add", "."], { cwd: sourceRoot });
  spawnSync("git", ["commit", "-q", "-m", "trusted updater"], { cwd: sourceRoot });
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const candidates = await buildRepositoryCandidates([{
    manifest: { schemaVersion: 1, id: "scott/example", version: "1.0.0", displayName: "Example", description: "Example", files: ["SKILL.md", "value.txt"], targets: { required: [target] } },
    files: new Map([["SKILL.md", Buffer.from("# Example\n")], ["value.txt", Buffer.from("stable")]])
  }], buildRoot, SOURCE_COMMIT, () => 1, { validateClaude: async () => {} });
  const index = promoteCandidates(emptyStableIndex(), candidates).index;
  const artifactPath = Object.values(index.skills["scott/example"].artifacts)[0].path;
  await writeFile(path.join(buildRoot, "quarantined.txt"), "must not publish");
  const plan = await createDistributionStage({ sourceRoot, buildRoot, distributionRoot, index });
  assert.equal(await readFile(path.join(plan.stage, artifactPath, "skills", providerSafeName("scott/example", target), "value.txt"), "utf8"), "stable\n");
  await assert.rejects(readFile(path.join(plan.stage, "quarantined.txt")));
  const marketplace = JSON.parse(await readFile(path.join(plan.stage, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].version, "1.0.0");
  assert.equal((await readFile(path.join(plan.stage, "updater", "0.1.0", "darwin", "skillmesh"), "utf8")).startsWith("#!/bin/sh"), true);
  const stagedIndex = JSON.parse(await readFile(path.join(plan.stage, "stable-index.json"), "utf8"));
  stagedIndex.skills["scott/example"].sourceCommit = "f".repeat(40);
  await writeFile(path.join(plan.stage, "stable-index.json"), JSON.stringify(stagedIndex));
  await assert.rejects(validateDistributionStage(plan.stage), { code: "ARTIFACT_METADATA" });
  stagedIndex.skills["scott/example"].sourceCommit = SOURCE_COMMIT;
  stagedIndex.skills["scott/example"].lifecycle = { state: "removed", graceDays: 7 };
  await writeFile(path.join(plan.stage, "stable-index.json"), JSON.stringify(stagedIndex));
  await assert.rejects(validateDistributionStage(plan.stage), { code: "ARTIFACT_METADATA" });
  stagedIndex.skills["scott/example"].lifecycle = { state: "enabled" };
  await writeFile(path.join(plan.stage, "stable-index.json"), JSON.stringify(stagedIndex));
  await writeFile(path.join(plan.stage, artifactPath, "skills", providerSafeName("scott/example", target), "value.txt"), "mutated\n");
  await assert.rejects(validateDistributionStage(plan.stage), { code: "DIGEST_MISMATCH" });
});

test("skill-only source commits preserve immutable same-version updater provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-updater-provenance-"));
  await updaterSource(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "updater A"], { cwd: root });
  const initial = await validateSourceUpdaterContract({ sourceRoot: root, index: emptyStableIndex() });
  await writeFile(path.join(root, "skill-only.txt"), "new skill\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "skill B"], { cwd: root });
  const later = await validateSourceUpdaterContract({ sourceRoot: root, index: { ...emptyStableIndex(), updater: initial.release } });
  assert.equal(later.changed, false);
  assert.deepEqual(later.release, initial.release);
  assert.notEqual(initial.release.sourceCommit, spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim());
});

test("source contract rejects updater template mutation without a version increase", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-updater-version-gate-"));
  await updaterSource(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "updater A"], { cwd: root });
  const initial = await validateSourceUpdaterContract({ sourceRoot: root, index: emptyStableIndex() });
  await writeFile(path.join(root, "updater", "darwin", "skillmesh"), "#!/bin/sh\nexit 7\n");
  await assert.rejects(validateSourceUpdaterContract({ sourceRoot: root, index: { ...emptyStableIndex(), updater: initial.release } }), { code: "UPDATER_VERSION_REQUIRED" });
});

test("source contract accepts a coherent updater bump and rejects package-runtime divergence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-updater-coherent-bump-"));
  await updaterSource(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "updater A"], { cwd: root });
  const initial = await validateSourceUpdaterContract({ sourceRoot: root, index: emptyStableIndex() });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  await writeFile(path.join(root, "src", "lib", "version.js"), "export const CURRENT_VERSION = \"0.2.0\";\n");
  await writeFile(path.join(root, "updater", "darwin", "skillmesh"), "#!/bin/sh\nexit 2\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "updater B"], { cwd: root });
  const bumped = await validateSourceUpdaterContract({ sourceRoot: root, index: { ...emptyStableIndex(), updater: initial.release } });
  assert.equal(bumped.release.version, "0.2.0");
  assert.equal(bumped.changed, true);
  await writeFile(path.join(root, "src", "lib", "version.js"), "export const CURRENT_VERSION = \"0.2.1\";\n");
  await assert.rejects(validateSourceUpdaterContract({ sourceRoot: root, index: { ...emptyStableIndex(), updater: initial.release } }), { code: "UPDATER_VERSION_SOURCE" });
});

test("full distribution validation rejects unreferenced quarantined content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-distribution-unreferenced-"));
  await mkdir(path.join(root, "artifacts", "quarantined", "0.0.0", "test"), { recursive: true });
  await writeFile(path.join(root, "stable-index.json"), JSON.stringify(emptyStableIndex()));
  await writeFile(path.join(root, "artifacts", "quarantined", "0.0.0", "test", "payload.txt"), "must not ship\n");
  await assert.rejects(validateDistributionStage(root, { stageOnly: false }), { code: "UNREFERENCED_ARTIFACT" });
});

test("full distribution validation rejects unknown top-level content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-distribution-top-level-"));
  await writeFile(path.join(root, "stable-index.json"), JSON.stringify(emptyStableIndex()));
  await writeFile(path.join(root, "unexpected.txt"), "not generated\n");
  await assert.rejects(validateDistributionStage(root, { stageOnly: false }), { code: "UNREFERENCED_ARTIFACT" });
});

test("distribution rejects a nested non-repository destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-boundary-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const nested = path.join(root, "distribution");
  await mkdir(nested);
  await assert.rejects(
    createDistributionStage({ sourceRoot: root, buildRoot: path.join(root, "build"), distributionRoot: nested, index: { skills: {}, generation: 0 } }),
    (error) => error.code === "DISTRIBUTION_BOUNDARY"
  );
});

test("distribution rejects traversal and false digests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-publish-bad-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const buildRoot = path.join(root, "build");
  await mkdir(sourceRoot);
  await mkdir(distributionRoot);
  await mkdir(buildRoot);
  spawnSync("git", ["init", "-q"], { cwd: sourceRoot });
  spawnSync("git", ["init", "-q"], { cwd: distributionRoot });
  const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
  const release = (artifactPath) => ({ logicalVersion: "1.0.0", providerRevision: 1, lifecycle: { state: "enabled" }, artifacts: {
    "codex--darwin--default--global": { target, path: artifactPath, digest: `sha256:${"a".repeat(64)}` }
  } });
  await assert.rejects(
    createDistributionStage({ sourceRoot, buildRoot, distributionRoot, index: { generation: 1, skills: { "scott/example": release("../outside") } }, stageUpdaterRelease: async ({ index }) => index }),
    (error) => ["PATH_TRAVERSAL", "ARTIFACT_ESCAPE"].includes(error.code)
  );
  await mkdir(path.join(buildRoot, "artifact"));
  await writeFile(path.join(buildRoot, "artifact", "file.txt"), "content");
  await assert.rejects(
    createDistributionStage({ sourceRoot, buildRoot, distributionRoot, index: { generation: 1, skills: { "scott/example": release("artifact") } }, stageUpdaterRelease: async ({ index }) => index }),
    (error) => error.code === "DIGEST_MISMATCH"
  );
});

test("distribution rejects the same GitHub origin expressed through SSH and HTTPS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-origin-alias-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  await mkdir(sourceRoot);
  await mkdir(distributionRoot);
  spawnSync("git", ["init", "-q"], { cwd: sourceRoot });
  spawnSync("git", ["init", "-q"], { cwd: distributionRoot });
  spawnSync("git", ["remote", "add", "origin", "https://github.com/Owner/Repo.git"], { cwd: sourceRoot });
  spawnSync("git", ["remote", "add", "origin", "git@github.com:owner/repo.git"], { cwd: distributionRoot });
  await assert.rejects(
    createDistributionStage({ sourceRoot, buildRoot: path.join(root, "build"), distributionRoot, index: { generation: 0, skills: {} } }),
    (error) => error.code === "DISTRIBUTION_BOUNDARY"
  );
});

test("distribution staging retains verified last-known-good artifacts absent from the new build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-lkg-stage-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const buildRoot = path.join(root, "build");
  for (const repo of [sourceRoot, distributionRoot]) { await mkdir(repo); spawnSync("git", ["init", "-q"], { cwd: repo }); }
  await mkdir(buildRoot);
  const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
  const oldPath = "artifacts/scott__quarantined/1.0.0/codex--darwin--default--global";
  const newPath = "artifacts/scott__valid/2.0.0/codex--darwin--default--global";
  await mkdir(path.join(distributionRoot, oldPath), { recursive: true });
  await mkdir(path.join(buildRoot, oldPath), { recursive: true });
  await mkdir(path.join(buildRoot, newPath), { recursive: true });
  await writeFile(path.join(distributionRoot, oldPath, "SKILL.md"), "old stable\n");
  await writeFile(path.join(buildRoot, oldPath, "SKILL.md"), "rebuilt metadata from an unchanged logical version\n");
  await writeFile(path.join(buildRoot, newPath, "SKILL.md"), "new stable\n");
  const release = async (skillId, artifactPath, rootPath) => {
    const artifactRoot = path.join(rootPath, artifactPath);
    const payloadDigest = await digestTree(artifactRoot);
    await writeFile(path.join(artifactRoot, "skillmesh-projection.json"), JSON.stringify({ schemaVersion: 1, generatorVersion: "1", logicalSkillId: skillId, logicalVersion: "1.0.0", providerRevision: 1, sourceCommit: SOURCE_COMMIT, lifecycle: { state: "enabled" }, targetKey: "codex--darwin--default--global", payloadDigest, executableFiles: [] }));
    return { logicalVersion: "1.0.0", providerRevision: 1, lifecycle: { state: "enabled" }, requiredTargets: ["codex--darwin--default--global"], sourceCommit: SOURCE_COMMIT, artifacts: {
      "codex--darwin--default--global": { target, path: artifactPath, digest: await digestTree(artifactRoot), schemaVersion: 1, generatorVersion: "1", payloadDigest }
    } };
  };
  const index = { schemaVersion: 1, generation: 2, skills: {
    "scott/quarantined": await release("scott/quarantined", oldPath, distributionRoot),
    "scott/valid": await release("scott/valid", newPath, buildRoot)
  } };
  const staged = await createDistributionStage({ sourceRoot, buildRoot, distributionRoot, index, stageUpdaterRelease: async ({ index }) => index });
  assert.equal(await readFile(path.join(staged.stage, oldPath, "SKILL.md"), "utf8"), "old stable\n");
  assert.equal(await readFile(path.join(staged.stage, newPath, "SKILL.md"), "utf8"), "new stable\n");
});

test("distribution publication creates a generated branch and delegates PR creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-pr-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const stage = path.join(root, "stage");
  for (const repo of [sourceRoot, distributionRoot]) {
    await mkdir(repo);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "initial\n");
    spawnSync("git", ["add", "README.md"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  }
  await mkdir(path.join(stage, "artifacts"), { recursive: true });
  await mkdir(path.join(stage, ".claude-plugin"));
  await writeFile(path.join(stage, "artifacts", "release.txt"), "stable");
  await writeFile(path.join(stage, ".claude-plugin", "marketplace.json"), "{}\n");
  await writeFile(path.join(stage, "stable-index.json"), '{"generation":4}\n');
  let ghCall;
  const result = await publishDistributionPullRequest({
    sourceRoot,
    distributionRoot,
    stage,
    generation: 4,
    validateStage: async () => ({ generation: 4 }),
    pushBranch: async () => {},
    runGh: async (args, cwd) => { if (args[1] === "view") throw new Error("not found"); ghCall = { args, cwd }; return "https://github.com/o/d/pull/1"; }
  });
  assert.equal(result.branch, "skillmesh/promote-generation-4-updater-none");
  assert.equal(await readFile(path.join(distributionRoot, "artifacts", "release.txt"), "utf8"), "stable");
  assert.equal(ghCall.cwd, distributionRoot);
  assert.ok(ghCall.args.includes("pr"));
});

test("distribution publication safely resumes after PR creation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-pr-retry-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const stage = path.join(root, "stage");
  for (const repo of [sourceRoot, distributionRoot]) {
    await mkdir(repo);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "initial\n");
    spawnSync("git", ["add", "README.md"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  }
  await mkdir(path.join(stage, "artifacts"), { recursive: true });
  await mkdir(path.join(stage, ".claude-plugin"));
  await writeFile(path.join(stage, "artifacts", "release.txt"), "stable");
  await writeFile(path.join(stage, ".claude-plugin", "marketplace.json"), "{}\n");
  await writeFile(path.join(stage, "stable-index.json"), '{"generation":9}\n');
  await assert.rejects(publishDistributionPullRequest({
    sourceRoot, distributionRoot, stage, generation: 9, validateStage: async () => ({ generation: 9 }),
    pushBranch: async () => {},
    runGh: async () => { throw new Error("network unavailable"); }
  }), /network unavailable/);
  const retried = await publishDistributionPullRequest({
    sourceRoot, distributionRoot, stage, generation: 9, validateStage: async () => ({ generation: 9 }),
    pushBranch: async () => {},
    runGh: async (args, cwd) => args[1] === "view"
      ? JSON.stringify({ url: "https://github.com/o/d/pull/9", headRefOid: spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim(), state: "OPEN" })
      : "unexpected"
  });
  assert.equal(retried.resumed, true);
  assert.equal(retried.url, "https://github.com/o/d/pull/9");
});

test("successive promotion branches always start from the stable base branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-pr-base-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  for (const repo of [sourceRoot, distributionRoot]) {
    await mkdir(repo);
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "initial\n");
    spawnSync("git", ["add", "README.md"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  }
  const makeStage = async (generation) => {
    const stage = path.join(root, `stage-${generation}`);
    await mkdir(path.join(stage, "artifacts"), { recursive: true });
    await mkdir(path.join(stage, ".claude-plugin"));
    await writeFile(path.join(stage, "artifacts", "release.txt"), `generation-${generation}`);
    await writeFile(path.join(stage, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFile(path.join(stage, "stable-index.json"), JSON.stringify({ generation }));
    return stage;
  };
  const createPr = async (args) => { if (args[1] === "view") throw new Error("not found"); return "pr"; };
  await publishDistributionPullRequest({ sourceRoot, distributionRoot, stage: await makeStage(1), generation: 1, validateStage: async () => ({ generation: 1 }), runGh: createPr, pushBranch: async () => {} });
  await publishDistributionPullRequest({ sourceRoot, distributionRoot, stage: await makeStage(2), generation: 2, validateStage: async () => ({ generation: 2 }), runGh: createPr, pushBranch: async () => {} });
  const main = spawnSync("git", ["rev-parse", "main"], { cwd: distributionRoot, encoding: "utf8" }).stdout.trim();
  const base = spawnSync("git", ["merge-base", "main", "skillmesh/promote-generation-2-updater-none"], { cwd: distributionRoot, encoding: "utf8" }).stdout.trim();
  const count = spawnSync("git", ["rev-list", "--count", "main..skillmesh/promote-generation-2-updater-none"], { cwd: distributionRoot, encoding: "utf8" }).stdout.trim();
  assert.equal(base, main);
  assert.equal(count, "1");
});

test("distribution publication pushes its generated branch before opening the PR", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-pr-push-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const remote = path.join(root, "distribution-remote.git");
  const stage = path.join(root, "stage");
  spawnSync("git", ["init", "--bare", "-q", remote]);
  for (const repo of [sourceRoot, distributionRoot]) {
    await mkdir(repo);
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "initial\n");
    spawnSync("git", ["add", "README.md"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  }
  spawnSync("git", ["remote", "add", "origin", remote], { cwd: distributionRoot });
  spawnSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: distributionRoot });
  await mkdir(path.join(stage, "artifacts"), { recursive: true });
  await mkdir(path.join(stage, ".claude-plugin"));
  await writeFile(path.join(stage, "artifacts", "release.txt"), "stable");
  await writeFile(path.join(stage, ".claude-plugin", "marketplace.json"), "{}\n");
  await writeFile(path.join(stage, "stable-index.json"), JSON.stringify({ generation: 1 }));
  let remoteVisibleAtPr = false;
  await publishDistributionPullRequest({
    sourceRoot, distributionRoot, stage, generation: 1, validateStage: async () => ({ generation: 1 }),
    runGh: async (args) => {
      if (args[1] === "view") throw new Error("not found");
      remoteVisibleAtPr = spawnSync("git", ["rev-parse", "--verify", "refs/heads/skillmesh/promote-generation-1-updater-none"], { cwd: remote }).status === 0;
      return "pr-url";
    }
  });
  assert.equal(remoteVisibleAtPr, true);
});
