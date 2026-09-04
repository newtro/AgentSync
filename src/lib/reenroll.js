import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { onboard, readEndpointConfig } from "./bootstrap.js";
import { invariant } from "./errors.js";
import { digestTree } from "./fs-tree.js";
import { stableStringify } from "./json.js";
import { providerSafeName } from "./compiler.js";
import { validateStableIndex } from "./release.js";
import { redact } from "./security.js";
import { synchronize } from "./updater.js";

export async function reenroll(repoPointer, { stateRoot, cloneOrUpdate, probeCapabilities, providerSync, now = new Date() }) {
  const old = await readEndpointConfig(stateRoot);
  invariant(!(old.pendingRetirements?.length), "REENROLL_RETIREMENTS_PENDING", "Complete the pending retirement plans with sync before changing repositories again");
  const token = randomUUID();
  const stagingRoot = `${stateRoot}.reenroll-${token}`;
  const projectRoots = [...new Set(old.enrollments.map((item) => item.projectRoot).filter(Boolean))];
  const staged = await onboard(repoPointer, {
    stateRoot: stagingRoot,
    home: os.homedir(),
    machine: old.enrollments[0]?.machine ?? os.hostname(),
    projectRoots,
    cloneOrUpdate,
    probeCapabilities,
    updaterExecutable: old.updaterExecutable ?? null,
    now
  });
  const validation = await validateDistribution(staged.config.distributionCheckout, staged.config.enrollments);
  const newIndex = validateStableIndex(JSON.parse(await readFile(path.join(staged.config.distributionCheckout, "stable-index.json"), "utf8")));
  const retirement = await retireOldTargets({ old, newIndex, stateRoot, providerSync, now });
  const orphanCleanup = retirement.statuses;

  const oldRepos = path.join(stateRoot, "repos");
  const backupRepos = path.join(stateRoot, `repos.previous-${token}`);
  const newRepos = path.join(stagingRoot, "repos");
  await mkdir(stateRoot, { recursive: true });
  let backedUp = false;
  try {
    try { await rename(oldRepos, backupRepos); backedUp = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(newRepos, oldRepos);
    const pendingRetirements = retirement.pendingPlans.map((plan) => ({
      ...plan,
      distributionCheckout: path.join(backupRepos, "distribution")
    }));
    const config = {
      ...staged.config,
      stateRoot,
      sourceCheckout: path.join(oldRepos, "source"),
      distributionCheckout: path.join(oldRepos, "distribution"),
      reenrolledAt: now.toISOString(),
      previousSourceRepo: old.sourceRepo,
      ...(backedUp ? { previousRepos: backupRepos } : {}),
      ...(pendingRetirements.length ? { pendingRetirements } : {})
    };
    const stageConfig = path.join(stateRoot, "config.json.stage");
    await writeFile(stageConfig, stableStringify(config), { mode: 0o600 });
    await rename(stageConfig, path.join(stateRoot, "config.json"));
    await rm(stagingRoot, { recursive: true, force: true });
    const credentialRevocation = {
      state: "assisted-action-required",
      reason: "SkillMesh stores no repository credential and cannot revoke credentials retained by Git, the OS credential store, GitHub, or the provider",
      action: `If access changed, revoke credentials and authorizations for ${old.sourceRepo}`
    };
    const pendingAccountBindings = config.enrollments.filter((item) => item.profile !== "default" && item.accountBinding === "unbound").map((item) => item.id);
    return { config, previousRepos: backedUp ? backupRepos : null, validation, orphanCleanup, pendingAccountBindings, pendingRetirements, repositorySwitched: true, complete: pendingAccountBindings.length === 0 && pendingRetirements.length === 0 && credentialRevocation.state === "completed", credentialRevocation };
  } catch (error) {
    await rm(oldRepos, { recursive: true, force: true });
    if (backedUp) await rename(backupRepos, oldRepos);
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function retireOldTargets({ old, newIndex, stateRoot, providerSync, now }) {
  if (!old.distributionCheckout || !old.enrollments?.length) return { statuses: [], pendingPlans: [] };
  let oldIndex;
  try { oldIndex = validateStableIndex(JSON.parse(await readFile(path.join(old.distributionCheckout, "stable-index.json"), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return { statuses: [], pendingPlans: [] }; else throw error; }
  const statuses = [];
  const pendingPlans = [];
  for (const enrollment of old.enrollments) {
    const key = `${enrollment.harness}--${enrollment.os}--${enrollment.profile}--${enrollment.scope}`;
    const skills = {};
    for (const [skillId, release] of Object.entries(oldIndex.skills)) {
      const artifact = release.artifacts?.[key];
      if (!artifact || (enrollment.mode === "direct" && newIndex.skills[skillId]?.artifacts?.[key])) continue;
      skills[skillId] = {
        ...structuredClone(release),
        artifacts: { [key]: artifact },
        requiredTargets: [key],
        deniedTargets: [],
        lifecycle: {
          state: "removed",
          removeAfter: now.toISOString(),
          emergencyOverride: { approvedBy: "explicit-reenrollment", reason: "Old managed target is absent from the newly selected repository", approvedAt: now.toISOString() }
        }
      };
    }
    if (!Object.keys(skills).length && enrollment.mode !== "marketplace") continue;
    const index = { schemaVersion: 1, generation: oldIndex.generation, skills };
    let attempt = await synchronize({ distributionRoot: old.distributionCheckout, distributionRepo: old.distributionRepo, index, enrollments: [enrollment], stateRoot, providerSync, providerRetireMarketplace: enrollment.mode === "marketplace", now });
    if (["assisted", "organization-marketplace"].includes(enrollment.mode)) attempt = attempt.map((item) => ({ ...item, action: `${item.action}; disconnect the old SkillMesh marketplace ${old.distributionRepo} before adding the new repository` }));
    statuses.push(...attempt);
    if (attempt.some(retirementPending)) pendingPlans.push({
      id: enrollment.id,
      enrollment,
      distributionRepo: old.distributionRepo,
      distributionCheckout: old.distributionCheckout,
      index,
      lastAttemptAt: now.toISOString(),
      lastStatuses: attempt
    });
  }
  return { statuses, pendingPlans };
}

export async function retryPendingRetirements(config, { stateRoot, providerSync, now = new Date() }) {
  const statuses = [];
  const remaining = [];
  for (const plan of config.pendingRetirements ?? []) {
    let attempt;
    try {
      attempt = await synchronize({
        distributionRoot: plan.distributionCheckout,
        distributionRepo: plan.distributionRepo,
        index: validateStableIndex(plan.index),
        enrollments: [plan.enrollment],
        stateRoot,
        providerSync,
        providerRetireMarketplace: plan.enrollment.mode === "marketplace",
        now,
        lock: false
      });
    } catch (error) {
      attempt = [{ endpointId: plan.enrollment.id, state: "failed", error: redact(error.message) }];
    }
    statuses.push(...attempt);
    if (attempt.some(retirementPending)) remaining.push({ ...plan, lastAttemptAt: now.toISOString(), lastStatuses: attempt });
  }
  const nextConfig = { ...config };
  if (remaining.length) nextConfig.pendingRetirements = remaining;
  else delete nextConfig.pendingRetirements;
  if ((config.pendingRetirements ?? []).length) {
    const stage = path.join(stateRoot, "config.json.stage");
    await writeFile(stage, stableStringify(nextConfig), { mode: 0o600 });
    await rename(stage, path.join(stateRoot, "config.json"));
  }
  return { config: nextConfig, statuses, pendingRetirements: remaining };
}

function retirementPending(status) {
  if (status.state === "failed" || status.state === "assisted-action-required") return true;
  return status.state === "unknown" && !(status.lifecycle === "removed" && status.installed === null);
}

async function validateDistribution(root, enrollments) {
  const index = validateStableIndex(JSON.parse(await readFile(path.join(root, "stable-index.json"), "utf8")));
  const selectedKeys = new Set(enrollments.map((item) => `${item.harness}--${item.os}--${item.profile}--${item.scope}`));
  let selectedArtifacts = 0;
  for (const [skillId, release] of Object.entries(index.skills ?? {})) {
    for (const [key, artifact] of Object.entries(release.artifacts ?? {})) {
      const absolute = path.resolve(root, artifact.path);
      invariant(absolute.startsWith(path.resolve(root) + path.sep), "ARTIFACT_ESCAPE", `Artifact escapes distribution during re-enrollment: ${skillId}`);
      invariant(await digestTree(absolute) === artifact.digest, "DIGEST_MISMATCH", `Artifact verification failed during re-enrollment: ${skillId}`);
      if (!selectedKeys.has(key)) continue;
      selectedArtifacts += 1;
      invariant(`${artifact.target.harness}--${artifact.target.os}--${artifact.target.profile}--${artifact.target.scope}` === key, "TARGET_MISMATCH", `Artifact target mismatch during re-enrollment: ${skillId}`);
      const skillPath = artifact.target.harness === "codex"
        ? path.join(absolute, "SKILL.md")
        : path.join(absolute, "skills", providerSafeName(skillId, artifact.target), "SKILL.md");
      const skill = await readFile(skillPath, "utf8");
      invariant(skill.startsWith("---\n") && skill.includes("\n---\n"), "SKILL_FRONTMATTER", `Projection is not loadable during re-enrollment: ${skillId}`);
    }
  }
  return { stableIndex: "verified", selectedArtifacts, accountBinding: "requires-provider-observation" };
}
