import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { providerSafeName } from "../src/lib/compiler.js";
import { digestTree } from "../src/lib/fs-tree.js";
import { reconcileClaudeCode } from "../src/lib/provider.js";

test("Claude Code reconciliation uses the exact generated plugin and shared account storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provider-"));
  const target = { harness: "claude-code", os: "darwin", profile: "organization", scope: "project" };
  const artifactPath = "artifacts/example";
  await mkdir(path.join(root, artifactPath, ".claude-plugin"), { recursive: true });
  const name = providerSafeName("scott/example", target);
  await writeFile(path.join(root, artifactPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "4.0.0" }));
  const index = { skills: { "scott/example": { logicalVersion: "1.0.0", providerRevision: 4, lifecycle: { state: "enabled" }, artifacts: {
    "claude-code--darwin--organization--project": { target, path: artifactPath, digest: await digestTree(path.join(root, artifactPath)) }
  } } } };
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, options });
    if (args[1] === "marketplace" && args[2] === "list") return { code: 0, stdout: JSON.stringify([{ installLocation: "/plugins", name: "skillmesh-stable", repo: "owner/distribution", source: "github", scope: "project" }]), stderr: "" };
    return { code: 0, stdout: args[1] === "list" ? JSON.stringify([{ id: `${name}@skillmesh-stable`, version: "4.0.0", scope: "project", enabled: true }]) : "", stderr: "" };
  };
  const result = await reconcileClaudeCode({
    enrollment: { harness: "claude-code", os: "darwin", profile: "organization", scope: "project", projectRoot: "/repo" },
    index,
    distributionRoot: root,
    distributionRepo: "git@github.com:owner/distribution.git",
    runner
  });
  assert.equal(result[0].sharedAcrossClaudeAccounts, true);
  assert.ok(calls.some((call) => call.args.includes(`${name}@skillmesh-stable`)));
  assert.ok(calls.every((call) => call.options.cwd === "/repo"));
  assert.ok(calls.some((call) => call.args.includes("--scope") && call.args.includes("project")));
  assert.equal(result[0].active, "unknown");
});

test("Claude Code verification rejects substring, wrong version, scope, or disabled matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provider-false-positive-"));
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const artifactPath = "artifact";
  await mkdir(path.join(root, artifactPath, ".claude-plugin"), { recursive: true });
  const name = providerSafeName("scott/example", target);
  await writeFile(path.join(root, artifactPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "2.0.0" }));
  const artifact = { target, path: artifactPath, digest: await digestTree(path.join(root, artifactPath)) };
  const index = { skills: { "scott/example": { providerRevision: 2, lifecycle: { state: "enabled" }, artifacts: { "claude-code--darwin--personal--global": artifact } } } };
  const runner = async (args) => {
    if (args[1] === "marketplace" && args[2] === "list") return { code: 0, stderr: "", stdout: JSON.stringify([{ name: "skillmesh-stable", repo: "repo", scope: "user" }]) };
    return { code: 0, stderr: "", stdout: args[1] === "list" ? JSON.stringify([{ id: "other@local", version: "2.0.0", scope: "local", enabled: false, description: name }]) : "" };
  };
  const result = await reconcileClaudeCode({ enrollment: { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" }, index, distributionRoot: root, distributionRepo: "repo", runner });
  assert.equal(result[0].state, "unknown");
  assert.equal(result[0].installed, "unknown");
});

test("Claude Code accepts the current marketplace list URL shape without an explicit scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provider-marketplace-url-"));
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const artifactPath = "artifact";
  const name = providerSafeName("scott/example", target);
  await mkdir(path.join(root, artifactPath, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(root, artifactPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
  const artifact = { target, path: artifactPath, digest: await digestTree(path.join(root, artifactPath)) };
  const index = { skills: { "scott/example": { providerRevision: 1, lifecycle: { state: "enabled" }, artifacts: { "claude-code--darwin--personal--global": artifact } } } };
  const runner = async (args) => {
    if (args[1] === "marketplace" && args[2] === "list") return { code: 0, stderr: "", stdout: JSON.stringify([{ name: "skillmesh-stable", source: "git", url: "https://github.com/newtro/AgentSync-Distribution.git" }]) };
    return { code: 0, stderr: "", stdout: args[1] === "list" ? JSON.stringify([{ id: `${name}@skillmesh-stable`, version: "1.0.0", scope: "user", enabled: true }]) : "" };
  };
  const result = await reconcileClaudeCode({ enrollment: target, index, distributionRoot: root, distributionRepo: "git@github.com:newtro/AgentSync-Distribution.git", runner });
  assert.equal(result[0].state, "installed");
});

test("one Claude plugin failure does not block an unrelated plugin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provider-isolation-"));
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const index = { skills: {} };
  for (const id of ["scott/a", "scott/b"]) {
    const artifactPath = `artifacts/${id.split("/")[1]}`;
    const name = providerSafeName(id, target);
    await mkdir(path.join(root, artifactPath, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(root, artifactPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    index.skills[id] = { providerRevision: 1, lifecycle: { state: "enabled" }, artifacts: { "claude-code--darwin--personal--global": { target, path: artifactPath, digest: await digestTree(path.join(root, artifactPath)) } } };
  }
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "install" && args[2].startsWith(providerSafeName("scott/a", target))) return { code: 1, stdout: "", stderr: "failed" };
    if (args[1] === "marketplace" && args[2] === "list") return { code: 0, stdout: JSON.stringify([{ name: "skillmesh-stable", repo: "repo", scope: "user" }]), stderr: "" };
    return { code: 0, stdout: args[1] === "list" ? JSON.stringify([]) : "", stderr: "" };
  };
  const result = await reconcileClaudeCode({ enrollment: { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" }, index, distributionRoot: root, distributionRepo: "repo", runner });
  assert.equal(result.find((item) => item.skillId === "scott/a").state, "failed");
  assert.equal(result.find((item) => item.skillId === "scott/b").state, "unknown");
  assert.ok(calls.some((args) => args[1] === "install" && args[2].startsWith(providerSafeName("scott/b", target))));
});

test("a newly denied Claude Code target uninstalls its shared plugin identity", async () => {
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const name = providerSafeName("scott/denied", target);
  const calls = [];
  const result = await reconcileClaudeCode({
    enrollment: target,
    index: { skills: { "scott/denied": { deniedTargets: ["claude-code--darwin--personal--global"], artifacts: {} } } },
    distributionRoot: "/distribution",
    distributionRepo: "repo",
    runner: async (args) => { calls.push(args); return { code: 0, stdout: args.includes("list") ? "[]" : "", stderr: "" }; }
  });
  assert.equal(result[0].state, "denied");
  assert.equal(result[0].active, "unknown");
  assert.ok(calls.some((args) => args[1] === "uninstall" && args[2] === `${name}@skillmesh-stable`));
  assert.equal(calls.some((args) => args[1] === "marketplace" && args[2] === "remove"), true);
  assert.equal(calls.some((args) => args[1] === "marketplace" && args[2] === "add"), false);
});

test("Claude reconciliation rejects a stale same-name marketplace before install", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provider-stale-market-"));
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const artifactPath = "artifact";
  const name = providerSafeName("scott/example", target);
  await mkdir(path.join(root, artifactPath, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(root, artifactPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
  const calls = [];
  const result = await reconcileClaudeCode({
    enrollment: target,
    index: { skills: { "scott/example": { providerRevision: 1, lifecycle: { state: "enabled" }, artifacts: { "claude-code--darwin--personal--global": { target, path: artifactPath, digest: await digestTree(path.join(root, artifactPath)) } } } } },
    distributionRoot: root,
    distributionRepo: "https://github.com/new/new-distribution.git",
    runner: async (args) => {
      calls.push(args);
      if (args[1] === "marketplace" && args[2] === "add") return { code: 1, stdout: "", stderr: "already exists" };
      if (args[1] === "marketplace" && args[2] === "list") return { code: 0, stdout: JSON.stringify([{ name: "skillmesh-stable", repo: "https://github.com/old/distribution.git", scope: "user" }]), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(result[0].state, "failed");
  assert.equal(calls.some((args) => args[1] === "install"), false);
});

test("Claude removal does not depend on access to the retired marketplace", async () => {
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const calls = [];
  const result = await reconcileClaudeCode({
    enrollment: target,
    index: { skills: { "scott/retired": { deniedTargets: ["claude-code--darwin--personal--global"], artifacts: {} } } },
    distributionRoot: "/retired-distribution",
    distributionRepo: "inaccessible-retired-repo",
    runner: async (args) => {
      calls.push(args);
      if (args[1] === "marketplace" && ["add", "update"].includes(args[2])) return { code: 1, stdout: "", stderr: "access denied" };
      return { code: 0, stdout: args.includes("list") ? "[]" : "", stderr: "" };
    }
  });
  assert.equal(result[0].state, "denied");
  assert.equal(calls.some((args) => args[1] === "marketplace" && ["add", "update"].includes(args[2])), false);
  assert.equal(calls.some((args) => args[1] === "marketplace" && args[2] === "remove"), true);
});

async function upgradeFixture({ install, update = () => ({ code: 0, stdout: "", stderr: "" }), installedVersion = "2.0.0" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provider-upgrade-"));
  const target = { harness: "claude-code", os: "darwin", profile: "personal", scope: "global" };
  const artifactPath = "artifact";
  const name = providerSafeName("scott/example", target);
  await mkdir(path.join(root, artifactPath, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(root, artifactPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "3.0.0" }));
  const artifact = { target, path: artifactPath, digest: await digestTree(path.join(root, artifactPath)) };
  const index = { skills: { "scott/example": { providerRevision: 3, lifecycle: { state: "enabled" }, artifacts: { "claude-code--darwin--personal--global": artifact } } } };
  const identity = `${name}@skillmesh-stable`;
  const calls = [];
  let listed = installedVersion;
  const runner = async (args) => {
    calls.push(args);
    if (args[1] === "marketplace" && args[2] === "list") return { code: 0, stderr: "", stdout: JSON.stringify([{ name: "skillmesh-stable", repo: "repo", scope: "user" }]) };
    if (args[1] === "install") { const result = install(identity); if (result.code === 0 && !/already installed/i.test(result.stdout)) listed = "3.0.0"; return result; }
    if (args[1] === "update") { const result = update(identity); if (result.code === 0) listed = "3.0.0"; return result; }
    return { code: 0, stderr: "", stdout: args[1] === "list" ? JSON.stringify(listed ? [{ id: identity, version: listed, scope: "user", enabled: true }] : []) : "" };
  };
  const result = await reconcileClaudeCode({ enrollment: target, index, distributionRoot: root, distributionRepo: "repo", runner });
  return { result, identity, updates: calls.filter((args) => args[1] === "update") };
}

test("Claude Code upgrades an already-installed plugin when install exits 0 and reports it on stdout", async () => {
  const { result, identity, updates } = await upgradeFixture({
    install: (id) => ({ code: 0, stderr: "", stdout: `Plugin "${id}" is already installed (scope: user) — the marketplace now offers 3.0.0 (installed: 2.0.0); run \`claude plugin update ${id}\` to get it\n` })
  });
  assert.deepEqual(updates, [["plugin", "update", identity, "--scope", "user"]]);
  assert.equal(result[0].state, "installed");
  assert.equal(result[0].installed, "3.0.0");
});

test("Claude Code still upgrades when an already-installed result fails on stderr", async () => {
  const { result, updates } = await upgradeFixture({ install: (id) => ({ code: 1, stdout: "", stderr: `Plugin ${id} is already installed` }) });
  assert.equal(updates.length, 1);
  assert.equal(result[0].state, "installed");
  assert.equal(result[0].installed, "3.0.0");
});

test("Claude Code skips update when the already-installed plugin is current", async () => {
  const { result, updates } = await upgradeFixture({
    installedVersion: "3.0.0",
    install: (id) => ({ code: 0, stderr: "", stdout: `Plugin "${id}" is already installed (scope: user)\n` }),
    update: () => ({ code: 1, stdout: "", stderr: "update should not run" })
  });
  assert.equal(updates.length, 0);
  assert.equal(result[0].state, "installed");
});

test("Claude Code reports a failed upgrade of an outdated already-installed plugin", async () => {
  const { result } = await upgradeFixture({
    install: (id) => ({ code: 0, stderr: "", stdout: `Plugin "${id}" is already installed (scope: user)\n` }),
    update: () => ({ code: 1, stdout: "", stderr: "fetch failed" })
  });
  assert.equal(result[0].state, "failed");
  assert.match(result[0].error, /fetch failed/);
});

test("Claude Code does not update after a fresh install", async () => {
  const { result, updates } = await upgradeFixture({
    installedVersion: null,
    install: (id) => ({ code: 0, stderr: "", stdout: `Successfully installed plugin: ${id} (scope: user)\n` })
  });
  assert.equal(updates.length, 0);
  assert.equal(result[0].state, "installed");
});

async function removalFixture({ uninstall, listedAfter = false }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provider-removal-"));
  const target = { harness: "claude-code", os: "darwin", profile: "organization", scope: "global" };
  const artifactPath = "artifact";
  const name = providerSafeName("scott/foreman", target);
  await mkdir(path.join(root, artifactPath, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(root, artifactPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "2.0.0" }));
  const artifact = { target, path: artifactPath, digest: await digestTree(path.join(root, artifactPath)) };
  const index = { skills: { "scott/foreman": { providerRevision: 2, lifecycle: { state: "removed" }, artifacts: { "claude-code--darwin--organization--global": artifact } } } };
  const identity = `${name}@skillmesh-stable`;
  const runner = async (args) => {
    if (args[1] === "uninstall") return uninstall(identity);
    if (args[1] === "marketplace" && args[2] === "list") return { code: 0, stderr: "", stdout: "[]" };
    return { code: 0, stderr: "", stdout: args[1] === "list" ? JSON.stringify(listedAfter ? [{ id: identity, version: "2.0.0", scope: "user", enabled: true }] : []) : "" };
  };
  return reconcileClaudeCode({ enrollment: target, index, distributionRoot: root, distributionRepo: "repo", runner });
}

const notFoundInInstalled = (id) => ({ code: 1, stdout: "", stderr: `Failed to uninstall plugin "${id}": Plugin "${id}" not found in installed plugins\n` });

test("Claude Code treats a plugin already uninstalled by another enrollment as removed", async () => {
  const result = await removalFixture({ uninstall: notFoundInInstalled });
  assert.equal(result[0].state, "removed");
  assert.equal(result[0].installed, null);
  assert.equal(result[0].error, undefined);
});

test("Claude Code verifies absence through plugin list after a not-found uninstall", async () => {
  const result = await removalFixture({ uninstall: notFoundInInstalled, listedAfter: true });
  assert.equal(result[0].state, "unknown");
  assert.equal(result[0].installed, "unknown");
});

test("Claude Code still reports other uninstall failures", async () => {
  const result = await removalFixture({ uninstall: (id) => ({ code: 1, stdout: "", stderr: `Failed to uninstall plugin "${id}": permission denied` }) });
  assert.equal(result[0].state, "failed");
  assert.match(result[0].error, /permission denied/);
});
