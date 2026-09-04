import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDistributionStage } from "../src/lib/publisher.js";
import { buildRepositoryCandidates, emptyStableIndex, promoteCandidates } from "../src/lib/release.js";

test("exact generated Claude plugin and marketplace pass installed strict validation", async (t) => {
  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) return t.skip("Claude CLI is not installed");
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-claude-validate-"));
  const sourceRoot = path.join(root, "source");
  const distributionRoot = path.join(root, "distribution");
  const buildRoot = path.join(root, "build");
  await mkdir(sourceRoot);
  await mkdir(distributionRoot);
  spawnSync("git", ["init", "-q"], { cwd: sourceRoot });
  spawnSync("git", ["init", "-q"], { cwd: distributionRoot });
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const skill = {
    manifest: { schemaVersion: 1, id: "scott/strict", version: "1.0.0", displayName: "Strict", description: "Strict validation fixture", files: ["SKILL.md"], targets: { required: [target] } },
    files: new Map([["SKILL.md", Buffer.from("# Strict\n")]])
  };
  const candidates = await buildRepositoryCandidates([skill], buildRoot, "c".repeat(40));
  const index = promoteCandidates(emptyStableIndex(), candidates).index;
  const stage = await createDistributionStage({ sourceRoot, buildRoot, distributionRoot, index, stageUpdaterRelease: async ({ index }) => index });
  const artifact = Object.values(index.skills["scott/strict"].artifacts)[0];
  const pluginResult = spawnSync("claude", ["plugin", "validate", "--strict", path.join(stage.stage, artifact.path)], { encoding: "utf8" });
  assert.equal(pluginResult.status, 0, pluginResult.stderr || pluginResult.stdout);
  const marketplaceResult = spawnSync("claude", ["plugin", "validate", "--strict", path.join(stage.stage, ".claude-plugin", "marketplace.json")], { encoding: "utf8" });
  assert.equal(marketplaceResult.status, 0, marketplaceResult.stderr || marketplaceResult.stdout);
});

test("removed Claude tombstones retain provider-valid skill frontmatter", async (t) => {
  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) return t.skip("Claude CLI is not installed");
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-claude-removed-"));
  const target = { harness: "claude-desktop", os: "darwin", profile: "personal", scope: "global" };
  const skill = {
    manifest: { schemaVersion: 1, id: "scott/removed", version: "1.0.0", displayName: "Removed", description: "Removed fixture", files: ["SKILL.md"], lifecycle: { state: "removed" }, targets: { required: [target] } },
    files: new Map([["SKILL.md", Buffer.from("# Former behavior\n")]])
  };
  const candidates = await buildRepositoryCandidates([skill], root, "c".repeat(40));
  const artifact = Object.values(candidates.candidates[0].artifacts)[0];
  const result = spawnSync("claude", ["plugin", "validate", "--strict", path.join(root, artifact.path)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
