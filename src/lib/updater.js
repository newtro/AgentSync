import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestTree } from "./fs-tree.js";
import { invariant } from "./errors.js";
import { stableStringify } from "./json.js";
import { redact } from "./security.js";
import { targetKey } from "./target.js";
import { CURRENT_VERSION } from "./version.js";
import { compareSemanticVersions } from "./release.js";

export const UPDATER_VERSION = CURRENT_VERSION;

export async function synchronize(options) {
  const { stateRoot } = options;
  if (options.lock === false) return await synchronizeUnlocked(options);
  return await withEndpointLock(stateRoot, () => synchronizeUnlocked(options));
}

export async function withEndpointLock(stateRoot, operation, options = {}) {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, "sync.lock");
  const lock = await acquireLock(lockPath, options.now ?? new Date());
  const heartbeat = setInterval(async () => {
    try {
      const heartbeatAt = new Date();
      await utimes(lockPath, heartbeatAt, heartbeatAt);
    } catch {
      // The owning operation still has the open handle; cleanup/failure remains in its finally block.
    }
  }, 30_000);
  heartbeat.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function acquireLock(lockPath, now) {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now.toISOString() }));
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const metadata = JSON.parse(await readFile(lockPath, "utf8"));
      let alive = true;
      try { process.kill(metadata.pid, 0); } catch (probeError) { alive = probeError.code === "EPERM"; }
      stale = !alive;
    } catch {
      const lockStat = await stat(lockPath);
      stale = now.getTime() - lockStat.mtimeMs > 30_000;
    }
    if (!stale) throw new Error("Another SkillMesh synchronization is already running");
    await rm(lockPath, { force: true });
    return await acquireLock(lockPath, now);
  }
}

async function synchronizeUnlocked({ distributionRoot, distributionRepo, index, enrollments, stateRoot, now = new Date(), providerSync, providerRetireMarketplace = false, runtimeAvailable = hasRuntime }) {
  const statuses = [];
  for (const enrollment of enrollments) {
    if (enrollment.enabled === false) {
      statuses.push({ endpointId: enrollment.id, state: "unknown", reason: "Harness is unsupported on this endpoint" });
      continue;
    }
    for (const [skillId, release] of Object.entries(index.skills ?? {})) {
      const key = enrollmentTargetKey(enrollment);
      if (release.deniedTargets?.includes(key)) {
        try {
          if (enrollment.mode === "direct") {
            await removeRelease({ stateRoot, enrollment, skillId, release, now });
            statuses.push(statusRecord(enrollment, skillId, "denied", { desired: null, installed: null, active: "unknown" }));
          } else if (enrollment.mode !== "marketplace") {
            statuses.push(statusRecord(enrollment, skillId, "assisted-action-required", { desired: null, installed: "unknown", active: "unknown", action: `Remove the previously installed ${skillId} from this denied provider endpoint and verify it is unavailable` }));
          }
        } catch (error) {
          statuses.push(statusRecord(enrollment, skillId, "failed", { desired: null, error: redact(error.message) }));
        }
      }
    }
    const matching = releasesForEnrollment(index, enrollment);
    if (enrollment.mode !== "direct") {
      if (enrollment.mode === "marketplace" && providerSync) {
        const hasDeniedTarget = Object.values(index.skills ?? {}).some((release) => release.deniedTargets?.includes(enrollmentTargetKey(enrollment)));
        if (!matching.length && !hasDeniedTarget && !providerRetireMarketplace) continue;
        try {
          const providerIndex = structuredClone(index);
          for (const release of Object.values(providerIndex.skills ?? {})) {
            if (release.lifecycle?.state === "removed" && !removalDue(release, now)) release.lifecycle = { ...release.lifecycle, state: "deprecated" };
          }
          const providerStatuses = await providerSync({ enrollment, index: providerIndex, distributionRoot, distributionRepo, retireMarketplace: providerRetireMarketplace });
          for (const item of providerStatuses) statuses.push(statusRecord(enrollment, item.skillId, item.state, item));
        } catch (error) {
          for (const item of matching) statuses.push(statusRecord(enrollment, item.skillId, "failed", { desired: item.release.logicalVersion, error: redact(error.message) }));
        }
        continue;
      }
      for (const item of matching) {
        const removing = removalDue(item.release, now);
        const state = enrollment.mode === "assisted" || removing ? "assisted-action-required" : "unknown";
        const action = removing
          ? enrollment.mode === "organization-marketplace"
            ? `In Claude organization plugin settings, remove ${item.skillId} from the private marketplace and verify it is unavailable to members`
            : `In Claude Desktop for the ${enrollment.profile} account, uninstall ${item.skillId} and verify it is no longer available`
          : enrollment.mode === "assisted"
            ? `In Claude Desktop for the ${enrollment.profile} account, add or refresh ${item.skillId} from ${distributionRepo}`
            : enrollment.mode === "organization-marketplace"
              ? `Verify the organization GitHub App, private marketplace auto-update, provider revision ${item.release.providerRevision}, and member refresh for ${item.skillId}`
              : undefined;
        statuses.push(statusRecord(enrollment, item.skillId, state, { desired: item.release.logicalVersion, lifecycle: item.release.lifecycle?.state ?? "enabled", accountBinding: enrollment.accountBinding ?? "unbound", ...(action ? { action } : {}) }));
      }
      continue;
    }
    for (const item of matching) {
      if (versionLessThan(UPDATER_VERSION, item.release.minimumUpdaterVersion ?? "0.0.0")) {
        statuses.push(statusRecord(enrollment, item.skillId, "pinned", { desired: item.release.logicalVersion, reason: `Updater ${item.release.minimumUpdaterVersion} or newer is required` }));
        continue;
      }
      try {
        if (removalDue(item.release, now)) statuses.push(await removeRelease({ stateRoot, enrollment, ...item, now }));
        else if (item.release.lifecycle?.state === "removed") {
          const installed = await installRelease({ distributionRoot, stateRoot, enrollment, ...item, now, runtimeAvailable });
          statuses.push({ ...installed, lifecycle: "deprecated" });
        }
        else statuses.push(await installRelease({ distributionRoot, stateRoot, enrollment, ...item, now, runtimeAvailable }));
      } catch (error) {
        statuses.push(statusRecord(enrollment, item.skillId, "failed", { desired: item.release.logicalVersion, error: redact(error.message) }));
      }
    }
  }
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path.join(stateRoot, "status.json"), stableStringify({ updatedAt: now.toISOString(), stableGeneration: index.generation ?? null, endpoints: statuses }));
  return statuses;
}

export async function installRelease({ distributionRoot, stateRoot, enrollment, skillId, release, artifact, now = new Date(), runtimeAvailable = hasRuntime }) {
  invariant(enrollment.mode === "direct" && enrollment.installRoot, "INSTALL_MODE", "Direct install requires an installation root");
  invariant(artifact.schemaVersion === 1 && artifact.generatorVersion === "1", "ARTIFACT_SCHEMA", `Unsupported artifact contract for ${skillId}`);
  invariant(/^sha256:[a-f0-9]{64}$/.test(artifact.payloadDigest ?? ""), "ARTIFACT_SCHEMA", `Invalid artifact payload digest for ${skillId}`);
  const source = path.resolve(distributionRoot, artifact.path);
  invariant(source.startsWith(path.resolve(distributionRoot) + path.sep), "ARTIFACT_ESCAPE", "Artifact path escapes the distribution root");
  invariant(!(await lstat(source)).isSymbolicLink(), "SYMLINK_FORBIDDEN", `Artifact root may not be a symlink: ${skillId}`);
  invariant(await digestTree(source) === artifact.digest, "DIGEST_MISMATCH", `Artifact digest mismatch for ${skillId}`);
  const metadata = JSON.parse(await readFile(path.join(source, "skillmesh-projection.json"), "utf8"));
  invariant(metadata.schemaVersion === 1 && metadata.generatorVersion === "1", "ARTIFACT_SCHEMA", `Projection contract is unsupported for ${skillId}`);
  invariant(metadata.logicalSkillId === skillId && metadata.logicalVersion === release.logicalVersion && metadata.providerRevision === release.providerRevision && metadata.sourceCommit === release.sourceCommit && stableStringify(metadata.lifecycle) === stableStringify(release.lifecycle), "ARTIFACT_METADATA", `Projection release metadata mismatch for ${skillId}`);
  invariant(metadata.targetKey === targetKey(artifact.target), "ARTIFACT_METADATA", `Projection target metadata mismatch for ${skillId}`);
  const observedPayload = await digestTree(source, { exclude: new Set(["skillmesh-projection.json"]) });
  invariant(metadata.payloadDigest === observedPayload && artifact.payloadDigest === observedPayload, "PAYLOAD_DIGEST", `Projection payload digest mismatch for ${skillId}`);
  const unavailable = [];
  for (const runtime of metadata.requiredRuntimes ?? []) if (!await runtimeAvailable(runtime)) unavailable.push(runtime);
  invariant(unavailable.length === 0, "RUNTIME_UNAVAILABLE", `Required runtimes are unavailable for ${skillId}: ${unavailable.join(", ")}`);

  const slug = managedSkillSlug(skillId);
  const destination = managedPath(enrollment.installRoot, slug);
  const stage = managedPath(enrollment.installRoot, `.skillmesh-stage-${slug}-${randomUUID()}`);
  const backup = managedPath(enrollment.installRoot, `.skillmesh-backup-${slug}-${randomUUID()}`);
  await mkdir(enrollment.installRoot, { recursive: true });
  await cp(source, stage, { recursive: true, errorOnExist: true });
  invariant(await digestTree(stage) === artifact.digest, "STAGE_VERIFY", `Staged digest mismatch for ${skillId}`);

  let hadExisting = false;
  let activated = false;
  let drifted = false;
  try {
    const prior = await readInstalledState(stateRoot, enrollment.id, skillId);
    const currentDigest = await safeDigest(destination);
    invariant(!currentDigest || prior?.activeDigest, "UNMANAGED_CONFLICT", `Refusing to replace unmanaged skill copy: ${skillId}`);
    if (currentDigest && prior?.activeDigest && currentDigest !== prior.activeDigest) {
      await preserveDrift({ stateRoot, enrollment, skillId, destination, priorDigest: prior.activeDigest, observedDigest: currentDigest, now });
      drifted = true;
    }
    if (currentDigest) {
      await rename(destination, backup);
      hadExisting = true;
    }
    await rename(stage, destination);
    activated = true;
    invariant(await digestTree(destination) === artifact.digest, "ACTIVATE_VERIFY", `Activated digest mismatch for ${skillId}`);
    await writeInstalledState(stateRoot, enrollment.id, skillId, {
      activeDigest: artifact.digest,
      logicalVersion: release.logicalVersion,
      installedAt: now.toISOString()
    });
    await rm(backup, { recursive: true, force: true });
    return statusRecord(enrollment, skillId, drifted ? "drifted" : "installed", { desired: release.logicalVersion, downloaded: release.logicalVersion, installed: release.logicalVersion, recoveredTo: drifted ? "stable" : undefined, active: "unknown" });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (hadExisting) {
      await rm(destination, { recursive: true, force: true });
      await rename(backup, destination);
    } else if (activated) {
      await rm(destination, { recursive: true, force: true });
    }
    throw error;
  }
}

function hasRuntime(runtime) {
  const command = runtime === "node" ? process.execPath : runtime === "python" ? "python3" : runtime === "powershell" ? "pwsh" : runtime === "sh" ? "sh" : null;
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export function releasesForEnrollment(index, enrollment) {
  const key = enrollmentTargetKey(enrollment);
  const releases = [];
  for (const [skillId, release] of Object.entries(index.skills ?? {})) {
    const artifact = release.artifacts?.[key];
    if (artifact) releases.push({ skillId, release, artifact });
  }
  return releases.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export async function removeRelease({ stateRoot, enrollment, skillId, release, now = new Date() }) {
  const destination = managedPath(enrollment.installRoot, managedSkillSlug(skillId));
  const prior = await readInstalledState(stateRoot, enrollment.id, skillId);
  const currentDigest = await safeDigest(destination);
  if (!currentDigest) return statusRecord(enrollment, skillId, "removed", { desired: null, installed: null, active: "verified-absent", lifecycle: "removed" });
  invariant(prior?.activeDigest, "REMOVE_UNMANAGED", `Refusing to remove an unmanaged copy of ${skillId}`);
  if (currentDigest !== prior.activeDigest) {
    await preserveDrift({ stateRoot, enrollment, skillId, destination, priorDigest: prior.activeDigest, observedDigest: currentDigest, now });
  }
  await rm(destination, { recursive: true });
  await writeInstalledState(stateRoot, enrollment.id, skillId, { ...prior, removedAt: now.toISOString(), lifecycle: "removed" });
  return statusRecord(enrollment, skillId, "unknown", { desired: null, installed: null, active: "unknown", lifecycle: "removed" });
}

function removalDue(release, now) {
  if (release.lifecycle?.state !== "removed") return false;
  const explicit = Date.parse(release.lifecycle.removeAfter ?? "");
  if (Number.isFinite(explicit)) return now.getTime() >= explicit;
  const promoted = Date.parse(release.promotedAt ?? "");
  if (!Number.isFinite(promoted)) return false;
  return now.getTime() >= promoted + (release.lifecycle.graceDays ?? 7) * 86_400_000;
}

function enrollmentTargetKey(enrollment) {
  return `${enrollment.harness}--${enrollment.os}--${enrollment.profile}--${enrollment.scope}`;
}

function versionLessThan(left, right) {
  return compareSemanticVersions(left, right) < 0;
}

async function preserveDrift({ stateRoot, enrollment, skillId, destination, priorDigest, observedDigest, now }) {
  const archive = managedPath(stateRoot, "drift", now.toISOString().replace(/[:.]/g, "-"), encodeURIComponent(enrollment.id), managedSkillSlug(skillId));
  await mkdir(path.dirname(archive), { recursive: true });
  await cp(destination, path.join(archive, "tree"), { recursive: true, errorOnExist: true });
  await writeFile(path.join(archive, "drift.json"), stableStringify({ skillId, endpointId: enrollment.id, priorDigest, observedDigest, preservedAt: now.toISOString() }));
}

async function safeDigest(directory) {
  try {
    return await digestTree(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function statusRecord(enrollment, skillId, state, extra) {
  return { endpointId: enrollment.id, skillId, state, ...extra };
}

async function installedStatePath(stateRoot, endpointIdValue, skillId) {
  return managedPath(stateRoot, "installed", encodeURIComponent(endpointIdValue), `${managedSkillSlug(skillId)}.json`);
}

function managedSkillSlug(skillId) {
  invariant(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9-]*$/.test(skillId), "SKILL_ID", `Unsafe managed skill id: ${skillId}`);
  return skillId.replace("/", "__");
}

function managedPath(root, ...segments) {
  const absoluteRoot = path.resolve(root);
  const value = path.resolve(absoluteRoot, ...segments);
  invariant(value.startsWith(absoluteRoot + path.sep), "MANAGED_PATH_ESCAPE", "Managed path escapes its configured root");
  return value;
}

async function readInstalledState(stateRoot, endpointIdValue, skillId) {
  try {
    return JSON.parse(await readFile(await installedStatePath(stateRoot, endpointIdValue, skillId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeInstalledState(stateRoot, endpointIdValue, skillId, value) {
  const filePath = await installedStatePath(stateRoot, endpointIdValue, skillId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stableStringify(value), { mode: 0o600 });
}
