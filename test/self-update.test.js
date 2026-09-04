import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { healthCommand, installUpdaterArtifact, reconcileUpdaterRelease } from "../src/lib/self-update.js";

test("self-update verifies, health-checks, and retains predecessor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-self-update-"));
  const artifactPath = path.join(root, "new");
  const executablePath = path.join(root, "bin", "skillmesh");
  await writeFile(artifactPath, "new-version");
  await writeFile(executablePath, "old-version").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(executablePath, "old-version");
  });
  const expectedDigest = `sha256:${createHash("sha256").update("new-version").digest("hex")}`;
  const result = await installUpdaterArtifact({ artifactPath, expectedDigest, executablePath, runHealth: async () => {} });
  assert.equal(await readFile(executablePath, "utf8"), "new-version");
  assert.equal(await readFile(`${executablePath}.previous`, "utf8"), "old-version");
  assert.equal(result.previousRetained, true);
});

test("sync lifecycle invokes a newer updater release or reports assisted source mode", async () => {
  const release = { version: "2.0.0", artifacts: { darwin: { path: "updater/tool", digest: `sha256:${"a".repeat(64)}` } } };
  const assisted = await reconcileUpdaterRelease({ release, distributionRoot: "/distribution", executablePath: null, currentVersion: "1.0.0" });
  assert.equal(assisted.state, "assisted-action-required");
  let invoked = false;
  const installed = await reconcileUpdaterRelease({
    release,
    distributionRoot: "/distribution",
    executablePath: "/bin/skillmesh",
    currentVersion: "1.0.0",
    platform: "darwin",
    install: async () => { invoked = true; }
  });
  assert.equal(invoked, true);
  assert.equal(installed.state, "installed");
});

test("self-update restores predecessor when activated health check fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-self-rollback-"));
  const artifactPath = path.join(root, "new");
  const executablePath = path.join(root, "skillmesh");
  await writeFile(artifactPath, "new-version");
  await writeFile(executablePath, "old-version");
  const expectedDigest = `sha256:${createHash("sha256").update("new-version").digest("hex")}`;
  let calls = 0;
  await assert.rejects(installUpdaterArtifact({
    artifactPath,
    expectedDigest,
    executablePath,
    runHealth: async () => { calls += 1; if (calls === 2) throw new Error("bad activated updater"); }
  }));
  assert.equal(await readFile(executablePath, "utf8"), "old-version");
});

test("Windows updater preserves cmd suffix and health-checks through ComSpec", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-self-windows-"));
  const artifactPath = path.join(root, "new.cmd");
  const executablePath = path.join(root, "Skill Mesh", "skillmesh.cmd");
  const template = "@echo off\r\n__SKILLMESH_NODE_COMMAND__ \"%~dp0..\\repos\\source\\src\\cli.js\" %*\r\n";
  await writeFile(artifactPath, template);
  const expectedDigest = `sha256:${createHash("sha256").update(template).digest("hex")}`;
  const checked = [];
  await installUpdaterArtifact({ artifactPath, expectedDigest, executablePath, nodePlatform: "win32", nodeExecutable: "C:\\Program Files\\nodejs\\node.exe", runHealth: async (file) => { checked.push(file); } });
  assert.match(checked[0], /\.stage\.cmd$/);
  assert.match(await readFile(executablePath, "utf8"), /^"C:\\Program Files\\nodejs\\node\.exe"/m);
  const invocation = healthCommand(executablePath, ["doctor", "--json"], { nodePlatform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /".*Skill Mesh.*skillmesh\.cmd"/);
});

test("promoted macOS launcher works with a minimal launchd PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-self-minimal-path-"));
  const stateRoot = path.join(root, "state");
  const artifactPath = path.join(root, "skillmesh-template");
  const executablePath = path.join(stateRoot, "bin", "skillmesh");
  const cliPath = path.join(stateRoot, "repos", "source", "src", "cli.js");
  const template = "#!/bin/sh\nset -eu\nstate_root=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\nexec __SKILLMESH_NODE_COMMAND__ \"$state_root/repos/source/src/cli.js\" \"$@\"\n";
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "process.stdout.write('healthy\\n');\n");
  await writeFile(artifactPath, template);
  const expectedDigest = `sha256:${createHash("sha256").update(template).digest("hex")}`;
  await installUpdaterArtifact({ artifactPath, expectedDigest, executablePath, nodePlatform: "darwin" });
  const run = spawnSync(executablePath, ["doctor", "--json"], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "healthy\n");
});
