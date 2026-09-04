import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";
import { discoverSkills } from "../src/lib/repository.js";
import { buildRepositoryCandidates, emptyStableIndex, promoteCandidates, rewrapRelease, restoreSnapshot, rollbackSkill, snapshotIndex, validateStableTransition } from "../src/lib/release.js";
import { createDistributionStage } from "../src/lib/publisher.js";
import { validateDistributionProvenance } from "../src/lib/provenance.js";

test("distribution CLI rejects a self-consistent updater not reproduced from trusted source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provenance-updater-"));
  const source = path.join(root, "source");
  const distribution = path.join(root, "distribution");
  const darwinPath = "updater/0.1.0/darwin/skillmesh";
  const windowsPath = "updater/0.1.0/win32/skillmesh.cmd";
  const trustedDarwin = "#!/bin/sh\nexit 0\n";
  const trustedWindows = "@exit /b 0\r\n";
  await mkdir(path.join(source, "updater", "darwin"), { recursive: true });
  await mkdir(path.join(source, "updater", "win32"), { recursive: true });
  await mkdir(path.join(distribution, path.dirname(darwinPath)), { recursive: true });
  await mkdir(path.join(distribution, path.dirname(windowsPath)), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await writeFile(path.join(source, "updater", "darwin", "skillmesh"), trustedDarwin);
  await writeFile(path.join(source, "updater", "win32", "skillmesh.cmd"), trustedWindows);
  await writeFile(path.join(distribution, darwinPath), trustedDarwin);
  await writeFile(path.join(distribution, windowsPath), trustedWindows);
  const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: source });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: source });
  spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: source });
  spawnSync("git", ["add", "."], { cwd: source });
  spawnSync("git", ["commit", "-q", "-m", "trusted"], { cwd: source });
  const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
  const index = { schemaVersion: 1, generation: 0, skills: {}, updater: { version: "0.1.0", sourceCommit, artifacts: { darwin: { path: darwinPath, digest: digest(trustedDarwin) }, win32: { path: windowsPath, digest: digest(trustedWindows) } } } };
  await writeFile(path.join(distribution, "stable-index.json"), JSON.stringify(index));
  const output = { lines: [], log(value) { this.lines.push(String(value)); }, error(value) { this.lines.push(String(value)); } };
  assert.equal(await main(["validate-distribution", "--distribution", distribution, "--source", source, "--json"], output), 0);
  const injected = "#!/bin/sh\necho injected-but-secret-free\nexit 0\n";
  await writeFile(path.join(distribution, darwinPath), injected);
  index.updater.artifacts.darwin.digest = digest(injected);
  await writeFile(path.join(distribution, "stable-index.json"), JSON.stringify(index));
  assert.equal(await main(["validate-distribution", "--distribution", distribution, "--source", source, "--json"], output), 1);
  assert.match(output.lines.at(-1), /SOURCE_PROVENANCE/);
});

test("rewrapped rollback and snapshot tombstones stage and reproduce from source history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provenance-restore-"));
  const source = path.join(root, "source");
  const distribution = path.join(root, "distribution");
  await mkdir(source);
  await mkdir(distribution);
  for (const repo of [source, distribution]) spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: source });
  spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: source });
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const writeSkill = async (name, version, body) => {
    const skillRoot = path.join(source, "skills", "scott", name);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "skill.json"), JSON.stringify({ schemaVersion: 1, id: `scott/${name}`, version, displayName: name, description: `${name} skill`, files: ["SKILL.md"], targets: { required: [target] } }));
    await writeFile(path.join(skillRoot, "SKILL.md"), body);
  };
  const commit = (message) => {
    spawnSync("git", ["add", "."], { cwd: source });
    const result = spawnSync("git", ["commit", "-q", "-m", message], { cwd: source, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
  };

  await writeSkill("example", "1.0.0", "# Example one\n");
  const commitA = commit("example v1");
  const buildA = path.join(root, "build-a");
  const candidatesA = await buildRepositoryCandidates(await discoverSkills(source), buildA, commitA);
  const stableA = promoteCandidates(emptyStableIndex(), candidatesA).index;
  const snapshot = snapshotIndex(stableA, "before-expansion", "2026-01-01T00:00:00Z");

  await writeSkill("example", "2.0.0", "# Example two\n");
  const commitB = commit("example v2");
  const buildB = path.join(root, "build-b");
  const candidatesB = await buildRepositoryCandidates(await discoverSkills(source), buildB, commitB, () => 2);
  const stableB = promoteCandidates(stableA, candidatesB).index;
  const rollbackBuild = path.join(root, "rollback-build");
  const rollbackRelease = await rewrapRelease({ priorRelease: { skillId: "scott/example", ...stableA.skills["scott/example"] }, buildRoot: buildA, outputRoot: rollbackBuild, providerRevision: 3 });
  const rolledBack = rollbackSkill(stableB, "scott/example", rollbackRelease);
  validateStableTransition(stableB, rolledBack);
  const rollbackStage = await createDistributionStage({ sourceRoot: source, buildRoot: rollbackBuild, distributionRoot: distribution, index: rolledBack, stageUpdaterRelease: async ({ index }) => index });
  await validateDistributionProvenance({ sourceRoot: source, distributionRoot: rollbackStage.stage, index: rolledBack });

  await writeSkill("extra", "1.0.0", "# Extra\n");
  const commitC = commit("add extra");
  const buildC = path.join(root, "build-c");
  const candidatesC = await buildRepositoryCandidates(await discoverSkills(source), buildC, commitC, (skillId, manifest) => {
    const prior = stableB.skills[skillId];
    return prior?.logicalVersion === manifest.version ? prior.providerRevision : (prior?.providerRevision ?? 0) + 1;
  }, { sourceCommitForSkill: (skillId, manifest) => {
    const prior = stableB.skills[skillId];
    return prior?.logicalVersion === manifest.version ? prior.sourceCommit : commitC;
  } });
  const stableC = promoteCandidates(stableB, candidatesC).index;
  const restoreBuild = path.join(root, "restore-build");
  const restoredExample = await rewrapRelease({ priorRelease: { skillId: "scott/example", ...stableA.skills["scott/example"] }, buildRoot: buildA, outputRoot: restoreBuild, providerRevision: 3 });
  const removedExtra = await rewrapRelease({ priorRelease: { skillId: "scott/extra", ...stableC.skills["scott/extra"] }, buildRoot: buildC, outputRoot: restoreBuild, providerRevision: 2, tombstone: true, lifecycle: { state: "removed", graceDays: 7 } });
  const restored = restoreSnapshot(stableC, snapshot, { "scott/example": restoredExample }, { "scott/extra": removedExtra }, new Date("2026-01-02T00:00:00Z"));
  validateStableTransition(stableC, restored);
  const restoreStage = await createDistributionStage({ sourceRoot: source, buildRoot: restoreBuild, distributionRoot: distribution, index: restored, stageUpdaterRelease: async ({ index }) => index });
  await validateDistributionProvenance({ sourceRoot: source, distributionRoot: restoreStage.stage, index: restored });
});
