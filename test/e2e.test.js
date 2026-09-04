import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEnrollments } from "../src/lib/adapters.js";
import { createDistributionStage } from "../src/lib/publisher.js";
import { buildRepositoryCandidates, emptyStableIndex, promoteCandidates } from "../src/lib/release.js";
import { discoverSkills } from "../src/lib/repository.js";
import { synchronize } from "../src/lib/updater.js";

function fullMatrix() {
  const targets = [];
  for (const osName of ["darwin", "windows"]) {
    for (const scope of ["global", "project"]) targets.push({ harness: "codex", os: osName, profile: "default", scope });
    for (const profile of ["personal", "organization"]) {
      for (const scope of ["global", "project"]) targets.push({ harness: "claude-code", os: osName, profile, scope });
      targets.push({ harness: "claude-desktop", os: osName, profile, scope: "global" });
    }
  }
  return targets;
}

test("one canonical skill builds, promotes, publishes, and converges across the full simulated endpoint matrix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-e2e-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const buildRoot = path.join(root, "build");
  const skillRoot = path.join(sourceRoot, "skills", "scott", "example");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(distributionRoot);
  spawnSync("git", ["init", "-q"], { cwd: sourceRoot });
  spawnSync("git", ["init", "-q"], { cwd: distributionRoot });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# Example\n\nUse the canonical behavior.\n");
  await writeFile(path.join(skillRoot, "skill.json"), JSON.stringify({
    schemaVersion: 1,
    id: "scott/example",
    version: "1.0.0",
    displayName: "Example",
    description: "Cross-harness fixture",
    files: ["SKILL.md"],
    targets: { required: fullMatrix(), denied: [] },
    smokeTests: [{ type: "file-contains", path: "SKILL.md", contains: "canonical behavior" }]
  }));
  const skills = await discoverSkills(sourceRoot);
  const candidates = await buildRepositoryCandidates(skills, buildRoot, "c".repeat(40), () => 1, { validateClaude: async () => {} });
  assert.equal(Object.keys(candidates.candidates[0].artifacts).length, 16);
  const index = promoteCandidates(emptyStableIndex(), candidates).index;
  const stage = await createDistributionStage({ sourceRoot, buildRoot, distributionRoot, index, stageUpdaterRelease: async ({ index }) => index });
  const marketplace = JSON.parse(await readFile(path.join(stage.stage, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins.length, 5);

  const macHome = path.join(root, "mac-home");
  const winHome = path.join(root, "windows-home");
  const macProject = path.join(root, "mac-project");
  const winProject = path.join(root, "windows-project");
  const enrollments = [
    ...createEnrollments({ home: macHome, machine: "mac", nodePlatform: "darwin", projectRoots: [macProject] }),
    ...createEnrollments({ home: winHome, machine: "pc", nodePlatform: "win32", projectRoots: [winProject] })
  ].map((enrollment) => enrollment.mode === "direct" ? enrollment : { ...enrollment, mode: "marketplace" });
  const providerSync = async () => [{ skillId: "scott/example", state: "installed", installed: "1.0.0", active: true }];
  const statuses = await synchronize({ distributionRoot: stage.stage, distributionRepo: "private-distribution", index, enrollments, stateRoot: path.join(root, "state"), providerSync });
  assert.equal(statuses.length, 16);
  assert.equal(statuses.filter((item) => item.state === "installed").length, 16);
  assert.equal(statuses.filter((item) => item.active === true).length, 12);
  assert.match(await readFile(path.join(macHome, ".agents", "skills", "scott__example", "SKILL.md"), "utf8"), /^---\nname: example/);
  assert.match(await readFile(path.join(macProject, ".agents", "skills", "scott__example", "SKILL.md"), "utf8"), /^---\nname: example/);
  assert.match(await readFile(path.join(winHome, ".agents", "skills", "scott__example", "SKILL.md"), "utf8"), /^---\nname: example/);
  assert.match(await readFile(path.join(winProject, ".agents", "skills", "scott__example", "SKILL.md"), "utf8"), /^---\nname: example/);

  const actualModes = [
    ...createEnrollments({ home: path.join(root, "actual-mac"), machine: "actual-mac", nodePlatform: "darwin", projectRoots: [path.join(root, "actual-mac-project")] }),
    ...createEnrollments({ home: path.join(root, "actual-windows"), machine: "actual-pc", nodePlatform: "win32", projectRoots: [path.join(root, "actual-windows-project")] })
  ];
  const truthful = await synchronize({ distributionRoot: stage.stage, distributionRepo: "private-distribution", index, enrollments: actualModes, stateRoot: path.join(root, "truthful-state") });
  assert.equal(truthful.length, 16);
  assert.equal(truthful.filter((item) => item.state === "installed").length, 4);
  assert.equal(truthful.filter((item) => item.state === "assisted-action-required").length, 2);
  assert.equal(truthful.filter((item) => item.state === "unknown").length, 10);
  assert.ok(truthful.filter((item) => item.state !== "installed").every((item) => item.active === undefined || item.active === "unknown"));
});
