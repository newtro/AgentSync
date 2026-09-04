import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { providerSafeName } from "./compiler.js";
import { digestTree } from "./fs-tree.js";
import { sameRepository } from "./git.js";
import { SkillMeshError } from "./errors.js";
import { redact } from "./security.js";

export async function reconcileClaudeCode({ enrollment, index, distributionRoot, distributionRepo, runner = runClaude, retireMarketplace = false }) {
  const desired = [];
  const removed = [];
  const results = [];
  for (const [skillId, release] of Object.entries(index.skills ?? {})) {
    const key = `${enrollment.harness}--${enrollment.os}--${enrollment.profile}--${enrollment.scope}`;
    if (release.deniedTargets?.includes(key)) {
      removed.push({ skillId, name: providerSafeName(skillId, { harness: enrollment.harness, os: enrollment.os, profile: enrollment.profile, scope: enrollment.scope }), scope: enrollment.scope === "project" ? "project" : "user", denied: true });
      continue;
    }
    const artifact = release.artifacts?.[key];
    if (!artifact) continue;
    try {
      if (await digestTree(path.join(distributionRoot, artifact.path)) !== artifact.digest) throw new SkillMeshError("DIGEST_MISMATCH", `Generated Claude plugin digest mismatch for ${skillId}`);
      const plugin = JSON.parse(await readFile(path.join(distributionRoot, artifact.path, ".claude-plugin", "plugin.json"), "utf8"));
      const expectedName = providerSafeName(skillId, artifact.target);
      if (plugin.name !== expectedName || plugin.version !== `${release.providerRevision}.0.0`) throw new SkillMeshError("PLUGIN_VERIFY", `Generated Claude plugin metadata mismatch for ${skillId}`);
      const item = { skillId, name: plugin.name, version: plugin.version, scope: enrollment.scope === "project" ? "project" : "user" };
      if (release.lifecycle?.state === "removed") removed.push(item);
      else desired.push(item);
    } catch (error) {
      results.push({ skillId, state: "failed", installed: "unknown", active: "unknown", error: redact(error.message) });
    }
  }

  const cwd = enrollment.projectRoot;
  for (const plugin of removed) {
    try {
      const identity = `${plugin.name}@skillmesh-stable`;
      const operation = await runner(["plugin", "uninstall", identity, "--scope", plugin.scope], { cwd });
      if (operation.code !== 0 && !/not installed/i.test(operation.stderr)) throw providerError(`plugin removal ${plugin.skillId}`, operation);
      const visible = await runner(["plugin", "list", "--json"], { cwd });
      let verifiedAbsent = false;
      if (visible.code === 0) {
        try {
          const records = JSON.parse(visible.stdout);
          verifiedAbsent = Array.isArray(records) && !records.some((record) => record.id === identity && record.scope === plugin.scope);
        } catch {
          verifiedAbsent = false;
        }
      }
      results.push({
        skillId: plugin.skillId,
        state: verifiedAbsent ? (plugin.denied ? "denied" : "removed") : "unknown",
        installed: verifiedAbsent ? null : "unknown",
        active: "unknown",
        ...(plugin.denied ? {} : { lifecycle: "removed" }),
        sharedAcrossClaudeAccounts: true
      });
    } catch (error) {
      results.push({ skillId: plugin.skillId, state: "failed", installed: "unknown", active: "unknown", error: redact(error.message) });
    }
  }
  if (desired.length) {
    try {
      const marketplaceScope = enrollment.scope === "project" ? "project" : "user";
      const add = await runner(["plugin", "marketplace", "add", distributionRepo, "--scope", marketplaceScope], { cwd });
      if (add.code !== 0 && !/already (?:exists|added)/i.test(add.stderr)) throw providerError("marketplace add", add);
      const visibleMarketplace = await runner(["plugin", "marketplace", "list", "--json"], { cwd });
      if (visibleMarketplace.code !== 0 || !marketplacePointsTo(visibleMarketplace.stdout, distributionRepo, marketplaceScope)) throw new SkillMeshError("PROVIDER_MARKETPLACE", "Claude marketplace identity does not match the configured distribution repository and scope");
      const refresh = await runner(["plugin", "marketplace", "update", "skillmesh-stable"], { cwd });
      if (refresh.code !== 0) throw providerError("marketplace update", refresh);
    } catch (error) {
      for (const plugin of desired) results.push({ skillId: plugin.skillId, state: "failed", installed: "unknown", active: "unknown", error: redact(error.message) });
      return results.sort((a, b) => a.skillId.localeCompare(b.skillId));
    }
  }
  for (const plugin of desired) {
    try {
      const identity = `${plugin.name}@skillmesh-stable`;
      let operation = await runner(["plugin", "install", identity, "--scope", plugin.scope], { cwd });
      if (operation.code !== 0 && /already installed/i.test(operation.stderr)) operation = await runner(["plugin", "update", identity, "--scope", plugin.scope], { cwd });
      if (operation.code !== 0) throw providerError(`plugin reconcile ${plugin.skillId}`, operation);
      const visible = await runner(["plugin", "list", "--json"], { cwd });
      let verified = false;
      if (visible.code === 0) {
        try {
          const records = JSON.parse(visible.stdout);
          verified = Array.isArray(records) && records.some((record) => record.id === identity && record.version === plugin.version && record.scope === plugin.scope && record.enabled === true);
        } catch {
          verified = false;
        }
      }
      results.push({ skillId: plugin.skillId, state: verified ? "installed" : "unknown", installed: verified ? plugin.version : "unknown", active: "unknown", accountBinding: enrollment.accountBinding ?? "unbound", sharedAcrossClaudeAccounts: true });
    } catch (error) {
      results.push({ skillId: plugin.skillId, state: "failed", installed: "unknown", active: "unknown", error: redact(error.message) });
    }
  }
  if (retireMarketplace || (removed.length > 0 && desired.length === 0)) {
    try {
      const marketplaceScope = enrollment.scope === "project" ? "project" : "user";
      const operation = await runner(["plugin", "marketplace", "remove", "skillmesh-stable", "--scope", marketplaceScope], { cwd });
      if (operation.code !== 0 && !/not (?:found|installed)|does not exist/i.test(operation.stderr)) throw providerError("marketplace removal", operation);
      const visible = await runner(["plugin", "marketplace", "list", "--json"], { cwd });
      if (visible.code !== 0 || marketplaceNamed(visible.stdout, marketplaceScope)) throw new SkillMeshError("PROVIDER_MARKETPLACE", "Claude marketplace removal could not be verified");
      if (!removed.length) results.push({ skillId: "skillmesh-stable", state: "removed", installed: null, active: "unknown", lifecycle: "removed", sharedAcrossClaudeAccounts: true });
    } catch (error) {
      if (!results.length) results.push({ skillId: "skillmesh-stable", state: "failed", installed: "unknown", active: "unknown", error: redact(error.message) });
      else for (const result of results) {
        if (["removed", "denied"].includes(result.state)) Object.assign(result, { state: "failed", active: "unknown", error: redact(error.message) });
      }
    }
  }
  return results.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

function marketplaceRecords(output) {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [];
  } catch {
    return [];
  }
}

function marketplaceNamed(output, scope) {
  return marketplaceRecords(output).some((record) => record?.name === "skillmesh-stable" && record.scope === scope);
}

function marketplacePointsTo(output, repository, scope) {
  return marketplaceRecords(output).some((record) => {
    if (record?.name !== "skillmesh-stable" || (record.scope && record.scope !== scope)) return false;
    const observed = record.repo ?? record.repository ?? record.url ?? record.source?.repo ?? record.source?.url ?? record.source;
    if (typeof observed !== "string") return false;
    const normalizedObserved = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(observed) ? `https://github.com/${observed}.git` : observed;
    try { return sameRepository(normalizedObserved, repository); } catch { return observed === repository; }
  });
}

function runClaude(args, options = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const quote = (value) => `"${String(value).replace(/%/g, "%%").replace(/"/g, '""')}"`;
    const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "claude";
    const commandArgs = windows ? ["/d", "/s", "/c", `"${["claude.cmd", ...args].map(quote).join(" ")}"`] : args;
    const child = spawn(command, commandArgs, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function providerError(operation, result) {
  return new SkillMeshError("PROVIDER_FAILED", `Claude ${operation} failed: ${redact(result.stderr || result.stdout)}`);
}
