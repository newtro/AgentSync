import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { reconcileClaudeCode } from "./provider.js";
import { redact } from "./security.js";
import { removeRelease } from "./updater.js";

export async function offboardEndpoint({ config, index, stateRoot, now = new Date(), removeSchedule = removeNativeSchedule, providerSync = reconcileClaudeCode, credentialRevocation = { state: "assisted-action-required", action: "Revoke repository credentials and GitHub/provider authorizations retained outside SkillMesh" } }) {
  const results = [];
  for (const enrollment of config.enrollments) {
    if (enrollment.mode === "direct") {
      const releases = new Map(Object.entries(index.skills ?? {}));
      const managed = new Set(await managedSkillIds(stateRoot, enrollment.id));
      for (const skillId of managed) {
        if (!releases.has(skillId)) releases.set(skillId, { lifecycle: { state: "removed" }, artifacts: {} });
      }
      for (const [skillId, release] of releases) {
        const key = `${enrollment.harness}--${enrollment.os}--${enrollment.profile}--${enrollment.scope}`;
        if (!release.artifacts?.[key] && !managed.has(skillId)) continue;
        try {
          const removed = await removeRelease({ stateRoot, enrollment, skillId, release, now });
          results.push({ ...removed, state: "removed" });
        } catch (error) {
          if (error.code !== "REMOVE_UNMANAGED") throw error;
          results.push({ endpointId: enrollment.id, skillId, state: "unknown", reason: "Unmanaged copy was left untouched" });
        }
      }
    } else if (enrollment.mode === "marketplace") {
      const removalIndex = structuredClone(index);
      for (const release of Object.values(removalIndex.skills ?? {})) release.lifecycle = { state: "removed", removeAfter: now.toISOString() };
      try {
        const providerResults = await providerSync({ enrollment, index: removalIndex, distributionRoot: config.distributionCheckout, distributionRepo: config.distributionRepo, retireMarketplace: true });
        results.push(...providerResults.map((item) => ({ endpointId: enrollment.id, ...item })));
      } catch (error) {
        results.push({ endpointId: enrollment.id, state: "failed", error: redact(error.message) });
      }
    } else {
      results.push({
        endpointId: enrollment.id,
        state: enrollment.mode === "assisted" || enrollment.mode === "organization-marketplace" ? "assisted-action-required" : "unknown",
        action: enrollment.mode === "marketplace" ? "Remove SkillMesh plugins with Claude Code plugin uninstall" : "Remove or disconnect the SkillMesh marketplace in Claude settings"
      });
    }
  }
  const schedule = await removeSchedule({ home: os.homedir(), nodePlatform: process.platform });
  if (schedule.complete === false) results.push({ endpointId: "native-schedule", state: "unknown", reason: schedule.reason });
  if (credentialRevocation.state !== "completed") results.push({ endpointId: "external-credentials", state: "assisted-action-required", action: credentialRevocation.action });
  const complete = !results.some((item) => ["failed", "assisted-action-required", "unknown"].includes(item.state));
  if (complete) await rm(path.join(stateRoot, "config.json"), { force: true });
  return { complete, results, credentialState: credentialRevocation, schedule, configRetained: !complete };
}

export async function removeNativeSchedule({ home = os.homedir(), nodePlatform = process.platform, runner = runNative }) {
  if (nodePlatform === "darwin") {
    const filePath = path.join(home, "Library", "LaunchAgents", "io.skillmesh.sync.plist");
    const label = `gui/${process.getuid?.() ?? ""}/io.skillmesh.sync`;
    const query = await runner("launchctl", ["print", label]);
    if (!query.started) return { removed: null, complete: false, reason: "launchctl was unavailable; schedule absence is unverified" };
    if (query.code === 0) {
      const unloaded = await runner("launchctl", ["bootout", label]);
      if (!unloaded.started || unloaded.code !== 0) return { removed: null, complete: false, reason: "launchctl could not confirm schedule removal" };
    }
    await rm(filePath, { force: true });
    const verified = await runner("launchctl", ["print", label]);
    if (!verified.started || verified.code === 0) return { removed: filePath, complete: false, reason: "launchd job remains loaded or could not be verified" };
    return { removed: filePath, complete: true };
  }
  if (nodePlatform === "win32") {
    const filePath = path.join(home, ".skillmesh", "SkillMesh-Sync.xml");
    const query = await runner("schtasks.exe", ["/Query", "/TN", "SkillMesh-Sync"]);
    if (!query.started) return { removed: null, complete: false, reason: "Task Scheduler was unavailable; task absence is unverified" };
    if (query.code === 0) {
      const deleted = await runner("schtasks.exe", ["/Delete", "/TN", "SkillMesh-Sync", "/F"]);
      if (!deleted.started || deleted.code !== 0) return { removed: null, complete: false, reason: "Task Scheduler could not confirm schedule removal" };
    }
    await rm(filePath, { force: true });
    const verified = await runner("schtasks.exe", ["/Query", "/TN", "SkillMesh-Sync"]);
    if (!verified.started || verified.code === 0) return { removed: filePath, complete: false, reason: "Scheduled task remains registered or could not be verified" };
    return { removed: filePath, taskSchedulerRemoval: "completed", complete: true };
  }
  return { removed: null, complete: true };
}

function runNative(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve({ started: false, code: null }));
    child.on("close", (code) => resolve({ started: true, code }));
  });
}

async function managedSkillIds(stateRoot, endpointId) {
  try {
    const entries = await readdir(path.join(stateRoot, "installed", encodeURIComponent(endpointId)), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5).replace("__", "/"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
