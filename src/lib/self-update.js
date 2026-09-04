import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { invariant } from "./errors.js";
import { compareSemanticVersions } from "./release.js";

export async function installUpdaterArtifact({ artifactPath, expectedDigest, executablePath, healthArgs = ["doctor", "--json"], runHealth = healthCheck, nodePlatform = process.platform, nodeExecutable = process.execPath }) {
  const artifact = await readFile(artifactPath);
  const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
  invariant(digest === expectedDigest, "UPDATER_DIGEST", "Updater artifact digest mismatch");
  await mkdir(path.dirname(executablePath), { recursive: true });
  const stage = nodePlatform === "win32" && path.extname(executablePath).toLowerCase() === ".cmd"
    ? `${executablePath.slice(0, -4)}.stage.cmd`
    : `${executablePath}.stage`;
  const backup = `${executablePath}.previous`;
  await rm(stage, { force: true });
  await writeFile(stage, renderUpdaterTemplate(artifact, { nodePlatform, nodeExecutable }), { mode: 0o700 });
  if (nodePlatform !== "win32") await chmod(stage, 0o700);
  await runHealth(stage, healthArgs, { nodePlatform });
  let hadCurrent = false;
  try {
    await rm(backup, { force: true });
    try {
      await rename(executablePath, backup);
      hadCurrent = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(stage, executablePath);
    await runHealth(executablePath, healthArgs, { nodePlatform });
    return { updated: true, previousRetained: hadCurrent, digest };
  } catch (error) {
    await rm(executablePath, { force: true });
    if (hadCurrent) await rename(backup, executablePath);
    await rm(stage, { force: true });
    throw error;
  }
}

export function renderUpdaterTemplate(artifact, { nodePlatform = process.platform, nodeExecutable = process.execPath } = {}) {
  const text = artifact.toString("utf8");
  const placeholder = "__SKILLMESH_NODE_COMMAND__";
  if (!text.includes(placeholder)) return artifact;
  invariant(text.indexOf(placeholder) === text.lastIndexOf(placeholder), "UPDATER_TEMPLATE", "Updater template must contain exactly one Node command placeholder");
  const command = nodePlatform === "win32"
    ? `"${String(nodeExecutable).replaceAll('"', '""').replaceAll("%", "%%")}"`
    : `'${String(nodeExecutable).replaceAll("'", `'"'"'`)}'`;
  return Buffer.from(text.replace(placeholder, command));
}

export async function reconcileUpdaterRelease({ release, distributionRoot, executablePath, currentVersion, platform = process.platform, install = installUpdaterArtifact }) {
  if (!release) return { state: "not-configured" };
  if (!isNewer(release.version, currentVersion)) return { state: "current", version: currentVersion };
  const artifact = release.artifacts?.[platform];
  if (!artifact) return { state: "assisted-action-required", desired: release.version, reason: `Updater release does not support platform ${platform}` };
  if (!executablePath) return { state: "assisted-action-required", desired: release.version, reason: "This source checkout is not configured as a replaceable updater executable" };
  const artifactPath = path.resolve(distributionRoot, artifact.path);
  if (!artifactPath.startsWith(path.resolve(distributionRoot) + path.sep)) throw new Error("Updater artifact path escapes distribution root");
  await install({ artifactPath, expectedDigest: artifact.digest, executablePath });
  return { state: "installed", version: release.version, active: "verified" };
}

function isNewer(left, right) {
  return compareSemanticVersions(String(left), String(right)) > 0;
}

export function healthCommand(executable, args, { nodePlatform = process.platform, comspec = process.env.ComSpec || "cmd.exe" } = {}) {
  if (nodePlatform === "win32" && path.extname(executable).toLowerCase() === ".cmd") {
    return { command: comspec, args: ["/d", "/s", "/c", windowsCmdLine(executable, args)] };
  }
  return { command: executable, args };
}

function windowsCmdLine(executable, args) {
  const command = [executable, ...args].map(windowsCommandQuote).join(" ");
  return `"${command}"`;
}

function windowsCommandQuote(value) {
  return `"${String(value).replaceAll('"', '""').replaceAll("%", "%%")}"`;
}

function healthCheck(executable, args, options) {
  return new Promise((resolve, reject) => {
    const invocation = healthCommand(executable, args, options);
    const child = spawn(invocation.command, invocation.args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Updater health check failed with status ${code}`)));
  });
}
