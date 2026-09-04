import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createManagedLauncher, onboard } from "../src/lib/bootstrap.js";
import { sameRepository, validateRepoPointer } from "../src/lib/git.js";

test("repo pointers reject embedded credentials", () => {
  assert.throws(() => validateRepoPointer("https://user:secret@github.com/o/r.git"), { code: "REPO_CREDENTIAL" });
  assert.throws(() => validateRepoPointer("https://github.com/o/r.git?token=secret"), { code: "REPO_CREDENTIAL" });
});

test("network repo pointers require authenticated GitHub transport", () => {
  assert.throws(() => validateRepoPointer("http://github.com/o/r.git"), { code: "REPO_POINTER" });
  assert.throws(() => validateRepoPointer("https://example.com/o/r.git"), { code: "REPO_POINTER" });
  assert.equal(validateRepoPointer("https://github.com/newtro/AgentSync.git"), "https://github.com/newtro/AgentSync.git");
});

test("normal onboarding can schedule a managed replaceable launcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-launcher-"));
  const launcher = await createManagedLauncher({ stateRoot: root, nodePlatform: "darwin", nodeExecutable: "/usr/bin/node", cliPath: "/Application Support/skillmesh/cli.js" });
  const content = await readFile(launcher, "utf8");
  assert.match(content, /^#!\/bin\/sh/);
  assert.match(content, /'\/Application Support\/skillmesh\/cli.js'/);
});

test("GitHub SSH and HTTPS forms resolve to the same repository identity", () => {
  assert.equal(sameRepository("https://github.com/Owner/Repo.git", "git@github.com:owner/repo.git"), true);
});

test("onboarding needs only the source pointer and discovers distribution plus endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-onboard-"));
  const source = path.join(root, "remote-source");
  const distribution = path.join(root, "remote-distribution");
  await mkdir(source);
  await mkdir(distribution);
  const project = path.join(root, "project");
  await mkdir(project);
  spawnSync("git", ["init", "-q"], { cwd: project });
  await writeFile(path.join(source, "skillmesh.config.json"), JSON.stringify({ schemaVersion: 1, distributionRepo: distribution }));
  const clone = async (repo, destination) => {
    await mkdir(destination, { recursive: true });
    if (repo === source) await writeFile(path.join(destination, "skillmesh.config.json"), await readFile(path.join(source, "skillmesh.config.json")));
  };
  const result = await onboard(source, {
    home: path.join(root, "home"),
    stateRoot: path.join(root, "state"),
    machine: "mac",
    nodePlatform: "darwin",
    projectRoots: [project],
    cloneOrUpdate: clone,
    probeCapabilities: async () => ({ diagnosticComplete: true, ready: false, targets: [] }),
    now: new Date("2026-01-01T00:00:00Z")
  });
  assert.equal(result.config.sourceRepo, source);
  assert.equal(result.config.distributionRepo, distribution);
  assert.equal(result.config.enrollments.length, 8);
  assert.ok(result.plans.some((plan) => plan.stateUntilVerified === "assisted-action-required"));
  assert.ok(result.config.enrollments.filter((item) => item.harness.startsWith("claude")).every((item) => item.accountBinding === "unbound"));
});

test("onboarding rejects missing or non-repository project roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-project-root-"));
  const source = path.join(root, "source");
  const distribution = path.join(root, "distribution");
  await mkdir(source);
  await mkdir(distribution);
  await writeFile(path.join(source, "skillmesh.config.json"), JSON.stringify({ schemaVersion: 1, distributionRepo: distribution }));
  const clone = async (repo, destination) => { await mkdir(destination, { recursive: true }); if (repo === source) await writeFile(path.join(destination, "skillmesh.config.json"), await readFile(path.join(source, "skillmesh.config.json"))); };
  await assert.rejects(onboard(source, { stateRoot: path.join(root, "state"), projectRoots: [path.join(root, "missing")], cloneOrUpdate: clone, probeCapabilities: async () => ({ targets: [] }) }));
});

test("onboarding validation failure leaves no committed config or native schedule", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-onboard-transaction-"));
  const source = path.join(root, "source");
  const distribution = path.join(root, "distribution");
  const stateRoot = path.join(root, "state");
  await mkdir(source);
  await mkdir(distribution);
  await writeFile(path.join(source, "skillmesh.config.json"), JSON.stringify({ schemaVersion: 1, distributionRepo: distribution }));
  const clone = async (repo, destination) => {
    await mkdir(destination, { recursive: true });
    if (repo === source) await writeFile(path.join(destination, "skillmesh.config.json"), await readFile(path.join(source, "skillmesh.config.json")));
  };
  let schedules = 0;
  await assert.rejects(onboard(source, {
    stateRoot,
    cloneOrUpdate: clone,
    probeCapabilities: async () => ({ targets: [] }),
    executable: "/managed/skillmesh",
    installSchedule: async () => { schedules += 1; },
    preCommit: async () => { throw new Error("tampered distribution"); }
  }), /tampered distribution/);
  assert.equal(schedules, 0);
  await assert.rejects(readFile(path.join(stateRoot, "config.json")), { code: "ENOENT" });
});

test("schedule installation failure retains a recoverable pending config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-onboard-schedule-failure-"));
  const source = path.join(root, "source");
  const distribution = path.join(root, "distribution");
  const stateRoot = path.join(root, "state");
  await mkdir(source);
  await mkdir(distribution);
  await writeFile(path.join(source, "skillmesh.config.json"), JSON.stringify({ schemaVersion: 1, distributionRepo: distribution }));
  const clone = async (repo, destination) => {
    await mkdir(destination, { recursive: true });
    if (repo === source) await writeFile(path.join(destination, "skillmesh.config.json"), await readFile(path.join(source, "skillmesh.config.json")));
  };
  await assert.rejects(onboard(source, {
    stateRoot,
    cloneOrUpdate: clone,
    probeCapabilities: async () => ({ targets: [] }),
    executable: "/managed/skillmesh",
    installSchedule: async () => { throw new Error("scheduler failed after native attempt"); },
    preCommit: async () => ({ validated: true })
  }), /scheduler failed/);
  const config = JSON.parse(await readFile(path.join(stateRoot, "config.json"), "utf8"));
  assert.equal(config.scheduleState, "pending");
  assert.equal(config.sourceRepo, source);
});
