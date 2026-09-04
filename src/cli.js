#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createManagedLauncher, defaultStateRoot, onboard, readEndpointConfig } from "./lib/bootstrap.js";
import { applyChangeBundleToBranch, createChangeBundle } from "./lib/authoring.js";
import { cloneOrUpdate, runGit } from "./lib/git.js";
import { stableStringify } from "./lib/json.js";
import { archiveMigrationOriginals, migrationProofDigest, prepareMigration, recordCanonicalReplacementProof, recordMigrationPublication, selectMigrationCandidate, stageMigrationImport } from "./lib/migration.js";
import { offboardEndpoint } from "./lib/offboard.js";
import { probeCapabilities } from "./lib/probe.js";
import { validateDistributionProvenance } from "./lib/provenance.js";
import { createDistributionStage, publishDistributionPullRequest, publishSourcePullRequest, validateDistributionStage, validateSourceUpdaterContract } from "./lib/publisher.js";
import { reconcileClaudeCode } from "./lib/provider.js";
import { reenroll, retryPendingRetirements } from "./lib/reenroll.js";
import { scanRepository } from "./lib/repo-security.js";
import { reconcileUpdaterRelease } from "./lib/self-update.js";
import { assertNoUnsafeDeletions, buildRepositoryCandidates, loadIndex, loadUpdaterRelease, promoteCandidates, restoreSnapshot, rewrapRelease, rollbackSkill, saveIndex, snapshotIndex, validateStableTransition } from "./lib/release.js";
import { discoverSkills, readJson } from "./lib/repository.js";
import { redact } from "./lib/security.js";
import { recordSyncAttempt, shouldRunScheduled } from "./lib/sync-control.js";
import { synchronize, withEndpointLock } from "./lib/updater.js";
import { CURRENT_VERSION } from "./lib/version.js";

const CLI_PATH = fileURLToPath(import.meta.url);

function usage() {
  return `SkillMesh ${CURRENT_VERSION}

Usage: skillmesh <command> [options]

Commands:
  doctor                         Inspect local harness capabilities
  security-scan [--root PATH]    Scan source before build/publication
  validate [--source PATH]       Validate canonical skills
  build [--source PATH]          Compile all required target projections
  promote --build PATH           Promote complete candidates into stable index
  publish-stage --build PATH     Stage stable-only distribution content
  publish-pr --stage PATH        Open the generated distribution pull request
  validate-distribution          Verify a distribution repository checkout
  bundle-create --skill PATH     Export a canonical Cowork handoff bundle
  bundle-apply --bundle PATH     Publish a validated Cowork bundle by pull request
  onboard REPOSITORY             One-pointer endpoint enrollment
  reenroll REPOSITORY            Validate and switch repository enrollment
  sync [--state PATH]            Refresh and converge local targets
  status [--state PATH]          Show truthful local endpoint state
  migrate [ACTION]               Inventory, select, stage, publish, prove, status, or archive migration
  snapshot --index PATH          Save an exact release manifest
  rollback --skill ID            Roll one skill back through a forward revision
  restore --snapshot PATH        Restore an exact set with forward revisions
  offboard [--state PATH]        Remove managed local endpoint state
  help                           Show this help
  version                        Show the SkillMesh version`;
}

export async function main(argv = process.argv.slice(2), io = console) {
  const [command = "help", ...rest] = argv;
  try {
    const parsed = parseArgs(rest);
    if (["help", "--help", "-h"].includes(command)) return output(io, usage());
    if (["version", "--version", "-v"].includes(command)) return output(io, CURRENT_VERSION);
    if (command === "doctor") return outputResult(io, { version: CURRENT_VERSION, ...await probeCapabilities() }, parsed.json);
    if (command === "security-scan") {
      const root = path.resolve(parsed.root ?? process.cwd());
      return outputResult(io, await scanRepository(root, parsed.revision ?? "working-tree"), parsed.json);
    }
    if (command === "validate") {
      const source = path.resolve(parsed.source ?? process.cwd());
      await scanRepository(source);
      const skills = await discoverSkills(source);
      return outputResult(io, { valid: true, skills: skills.map((skill) => skill.manifest.id) }, parsed.json);
    }
    if (command === "build") {
      const source = path.resolve(parsed.source ?? process.cwd());
      const buildRoot = path.resolve(parsed.out ?? path.join(source, ".skillmesh", "build"));
      const sourceCommit = parsed.commit ?? await runGit(["rev-parse", "HEAD"], { cwd: source }).catch(() => "working-tree");
      await scanRepository(source, sourceCommit);
      const skills = await discoverSkills(source);
      const index = await loadIndex(path.resolve(parsed.index ?? path.join(source, ".skillmesh", "stable-index.json")));
      assertNoUnsafeDeletions(skills, index);
      const candidates = await buildRepositoryCandidates(skills, buildRoot, sourceCommit, (skillId, manifest) => {
        const previous = index.skills[skillId];
        return previous?.logicalVersion === manifest.version ? previous.providerRevision : (previous?.providerRevision ?? 0) + 1;
      }, {
        sourceCommitForSkill: (skillId, manifest) => {
          const previous = index.skills[skillId];
          return previous?.logicalVersion === manifest.version ? previous.sourceCommit : sourceCommit;
        }
      });
      outputResult(io, { built: candidates.candidates.length, quarantined: candidates.quarantined, buildRoot, sourceCommit }, parsed.json);
      return candidates.quarantined.length && !parsed["allow-quarantine"] ? 1 : 0;
    }
    if (command === "promote") {
      requireOption(parsed.build, "--build");
      const buildRoot = path.resolve(parsed.build);
      const candidates = await readJson(path.join(buildRoot, "candidates.json"));
      const indexPath = path.resolve(parsed.index ?? path.join(buildRoot, "stable-index.json"));
      const current = await loadIndex(indexPath);
      const result = promoteCandidates(current, candidates, parsed.skill?.length ? { skillIds: parsed.skill } : {});
      if (parsed.source) await validateSourceUpdaterContract({ sourceRoot: path.resolve(parsed.source), index: result.index });
      const outputIndexPath = path.resolve(parsed["out-index"] ?? indexPath);
      await saveIndex(outputIndexPath, result.index);
      return outputResult(io, { promoted: result.promoted, generation: result.index.generation, indexPath: outputIndexPath }, parsed.json);
    }
    if (command === "publish-stage") {
      requireOption(parsed.build, "--build");
      requireOption(parsed.distribution, "--distribution");
      const indexPath = path.resolve(parsed.index ?? path.join(parsed.build, "stable-index.json"));
      const plan = await createDistributionStage({
        sourceRoot: path.resolve(parsed.source ?? process.cwd()),
        buildRoot: path.resolve(parsed.build),
        distributionRoot: path.resolve(parsed.distribution),
        index: await loadIndex(indexPath)
      });
      return outputResult(io, plan, parsed.json);
    }
    if (command === "validate-distribution") {
      const distribution = path.resolve(parsed.distribution ?? process.cwd());
      await scanRepository(distribution, parsed.revision ?? "working-tree");
      const index = await validateDistributionStage(distribution, { stageOnly: false });
      if (parsed["base-index"]) validateStableTransition(await readJson(path.resolve(parsed["base-index"])), index);
      if (parsed.source) {
        const source = path.resolve(parsed.source);
        await validateDistributionProvenance({ sourceRoot: source, distributionRoot: distribution, index });
      }
      return outputResult(io, { valid: true, generation: index.generation, skills: Object.keys(index.skills).sort(), updater: index.updater?.version ?? null }, parsed.json);
    }
    if (command === "publish-pr") {
      requireOption(parsed.distribution, "--distribution");
      requireOption(parsed.stage, "--stage");
      requireOption(parsed.generation, "--generation");
      return outputResult(io, await publishDistributionPullRequest({
        sourceRoot: path.resolve(parsed.source ?? process.cwd()),
        distributionRoot: path.resolve(parsed.distribution),
        stage: path.resolve(parsed.stage),
        generation: Number(parsed.generation)
      }), parsed.json);
    }
    if (command === "bundle-create") {
      requireOption(parsed.skill, "--skill");
      requireOption(parsed.out, "--out");
      const bundle = await createChangeBundle(path.resolve(firstOption(parsed.skill)), path.resolve(parsed.out));
      return outputResult(io, { bundle: path.resolve(parsed.out), skillId: bundle.manifest.id, digest: bundle.digest }, parsed.json);
    }
    if (command === "bundle-apply") {
      requireOption(parsed.bundle, "--bundle");
      return outputResult(io, await applyChangeBundleToBranch(path.resolve(parsed.bundle), path.resolve(parsed.source ?? process.cwd()), {
        replace: parsed.replace ?? false,
        baseBranch: parsed.base,
        publishPullRequest: publishSourcePullRequest
      }), parsed.json);
    }
    if (command === "onboard") {
      requireOption(parsed._[0], "repository pointer");
      const state = path.resolve(parsed.state ?? defaultStateRoot());
      const launcher = await createManagedLauncher({ stateRoot: state, nodeExecutable: process.execPath, cliPath: CLI_PATH });
      const result = await onboard(parsed._[0], {
        stateRoot: state,
        projectRoots: parsed.project?.map((value) => path.resolve(value)) ?? [],
        executable: launcher,
        commandArgs: ["sync", "--scheduled", "--state", state],
        updaterExecutable: launcher,
        dryRunSchedule: parsed["dry-run-schedule"] ?? false,
        preCommit: async (config) => {
          const indexPath = path.join(config.distributionCheckout, "stable-index.json");
          const index = await validateDistributionStage(config.distributionCheckout, { stageOnly: false });
          await validateDistributionProvenance({ sourceRoot: config.sourceCheckout, distributionRoot: config.distributionCheckout, index });
          return { indexPath, index, updaterRelease: await loadUpdaterRelease(indexPath) };
        }
      });
      const updater = await reconcileUpdaterRelease({ release: result.preCommit.updaterRelease, distributionRoot: result.config.distributionCheckout, executablePath: result.config.updaterExecutable, currentVersion: CURRENT_VERSION, forceCurrentInstall: true });
      const statuses = await synchronize({ distributionRoot: result.config.distributionCheckout, distributionRepo: result.config.distributionRepo, index: result.preCommit.index, enrollments: result.config.enrollments, stateRoot: state, providerSync: reconcileClaudeCode });
      const failed = statuses.some((status) => status.state === "failed");
      outputResult(io, {
        configured: true,
        initialSynchronization: statuses.length ? "attempted" : "no-stable-skills",
        converged: statuses.length > 0 && statuses.every((status) => status.state === "installed" && status.active !== "unknown"),
        endpoints: result.config.enrollments.length,
        updater,
        statuses,
        plans: result.plans,
        schedule: result.schedule
      }, parsed.json);
      return failed ? 1 : 0;
    }
    if (command === "sync") {
      const stateRoot = path.resolve(parsed.state ?? defaultStateRoot());
      if (parsed.scheduled && !await shouldRunScheduled(stateRoot)) return outputResult(io, { synchronized: false, skipped: "backoff-or-jitter" }, parsed.json);
      return await withEndpointLock(stateRoot, async () => {
        let config = await readEndpointConfig(stateRoot);
        try {
          const retirement = await retryPendingRetirements(config, { stateRoot, providerSync: reconcileClaudeCode });
          config = retirement.config;
          await cloneOrUpdate(config.sourceRepo, config.sourceCheckout);
          await cloneOrUpdate(config.distributionRepo, config.distributionCheckout);
          const indexPath = path.join(config.distributionCheckout, "stable-index.json");
          const updater = await reconcileUpdaterRelease({ release: await loadUpdaterRelease(indexPath), distributionRoot: config.distributionCheckout, executablePath: config.updaterExecutable, currentVersion: CURRENT_VERSION });
          const index = await loadIndex(indexPath);
          const statuses = await synchronize({ distributionRoot: config.distributionCheckout, distributionRepo: config.distributionRepo, index, enrollments: config.enrollments, stateRoot, providerSync: reconcileClaudeCode, lock: false });
          await recordSyncAttempt({ stateRoot, statuses });
          const failed = statuses.some((status) => status.state === "failed");
          const converged = statuses.length > 0 && statuses.every((status) => status.state === "installed" && status.active !== "unknown");
          outputResult(io, { completed: true, synchronized: converged && retirement.pendingRetirements.length === 0, converged, updater, statuses, retirementStatuses: retirement.statuses, pendingRetirements: retirement.pendingRetirements }, parsed.json);
          return failed ? 1 : 0;
        } catch (error) {
          await recordSyncAttempt({ stateRoot, error });
          throw error;
        }
      });
    }
    if (command === "status") {
      const stateRoot = path.resolve(parsed.state ?? defaultStateRoot());
      const status = await readJson(path.join(stateRoot, "status.json"));
      const config = await readEndpointConfig(stateRoot).catch(() => ({}));
      return outputResult(io, { ...status, ...(config.pendingRetirements?.length ? { pendingRetirements: config.pendingRetirements } : {}) }, parsed.json);
    }
    if (command === "migrate") {
      const stateRoot = path.resolve(parsed.state ?? defaultStateRoot());
      const action = parsed._[0] ?? "inventory";
      if (action !== "inventory") {
        requireOption(parsed.proposal, "--proposal");
        const proposalPath = path.resolve(parsed.proposal);
        const proposalRoot = path.dirname(proposalPath);
        let proposal = await readJson(proposalPath);
        if (action === "select") {
          requireOption(parsed.group, "--group");
          requireOption(parsed.candidate, "--candidate");
          requireOption(parsed.reviewer, "--reviewer");
          proposal = await selectMigrationCandidate({ proposal, proposalRoot, groupKey: parsed.group, candidateId: parsed.candidate, selectedBy: parsed.reviewer });
          return outputResult(io, { action, group: parsed.group, status: proposal.groups.find((item) => item.key === parsed.group)?.status }, parsed.json);
        }
        if (action === "stage") {
          requireOption(parsed.group, "--group");
          const staged = await stageMigrationImport({ proposal, proposalRoot, groupKey: parsed.group });
          return outputResult(io, { action, group: parsed.group, importRoot: staged.importRoot, next: "Add a canonical skill.json, then run migrate publish with --manifest" }, parsed.json);
        }
        if (action === "publish") {
          requireOption(parsed.group, "--group");
          requireOption(parsed.manifest, "--manifest");
          const group = proposal.groups.find((item) => item.key === parsed.group);
          requireOption(group?.import?.path, `staged import for ${parsed.group}`);
          const manifest = await readJson(path.resolve(parsed.manifest));
          await writeFile(path.join(group.import.path, "skill.json"), stableStringify(manifest), { mode: 0o600 });
          const bundlePath = path.join(proposalRoot, `migration-${encodeURIComponent(parsed.group)}.skillmesh.json`);
          await createChangeBundle(group.import.path, bundlePath);
          const published = await applyChangeBundleToBranch(bundlePath, path.resolve(parsed.source ?? process.cwd()), {
            replace: parsed.replace ?? false,
            baseBranch: parsed.base,
            bodyContext: `Migration group ${parsed.group}; selected tree ${group.selectedDigest}; proposal ${migrationProofDigest(proposal)}.`,
            publishPullRequest: publishSourcePullRequest
          });
          proposal = await recordMigrationPublication({
            proposal, proposalRoot, groupKey: parsed.group,
            publication: { selectedDigest: group.selectedDigest, bundleDigest: published.digest, branch: published.branch, commit: published.commit, pullRequest: published.pullRequest?.url ?? published.pullRequest }
          });
          return outputResult(io, { action, group: parsed.group, bundlePath, pullRequest: published.pullRequest, branch: published.branch, proposalStatus: proposal.groups.find((item) => item.key === parsed.group)?.status }, parsed.json);
        }
        if (action === "prove") {
          requireOption(parsed.group, "--group");
          requireOption(parsed.proof, "--proof");
          proposal = await recordCanonicalReplacementProof({ proposal, proposalRoot, groupKey: parsed.group, proof: await readJson(path.resolve(parsed.proof)) });
          return outputResult(io, { action, group: parsed.group, status: proposal.groups.find((item) => item.key === parsed.group)?.status, proofDigest: migrationProofDigest(proposal) }, parsed.json);
        }
        if (action === "status") return outputResult(io, { action, proofDigest: migrationProofDigest(proposal), groups: proposal.groups.map((group) => ({ key: group.key, status: group.status, pendingEndpoints: group.replacementProof?.pendingEndpoints ?? [] })) }, parsed.json);
        if (action === "archive") {
          requireOption(parsed.reviewer, "--reviewer");
          requireOption(parsed["confirm-proof"], "--confirm-proof");
          const archived = await archiveMigrationOriginals({ proposal, proposalRoot, confirmation: { confirmedBy: parsed.reviewer, confirmedAt: new Date().toISOString(), proofDigest: parsed["confirm-proof"] } });
          return outputResult(io, { action, ...archived }, parsed.json);
        }
        throw new Error(`Unknown migrate action: ${action}`);
      }
      const home = os.homedir();
      const roots = [
        { name: "codex-current", root: path.join(home, ".agents", "skills") },
        { name: "codex-legacy", root: path.join(home, ".codex", "skills") },
        { name: "claude-code", root: path.join(home, ".claude", "skills") }
      ];
      try {
        const config = await readEndpointConfig(stateRoot);
        for (const enrollment of config.enrollments.filter((item) => item.projectRoot)) {
          const folder = enrollment.harness === "codex" ? ".agents" : ".claude";
          roots.push({ name: `${enrollment.harness}-${enrollment.projectRoot}`, root: path.join(enrollment.projectRoot, folder, "skills") });
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const exportRoot of parsed.export ?? []) roots.push({ name: `claude-export-${roots.length + 1}`, root: path.resolve(exportRoot) });
      const result = await prepareMigration({ roots, stateRoot });
      return outputResult(io, {
        proposalRoot: result.proposalRoot,
        groups: result.proposal.groups,
        unobservableSources: [
          { harness: "claude-desktop", profile: "personal", action: "Export or download the skill from Claude and rerun migration with the exported folder" },
          { harness: "claude-desktop", profile: "organization", action: "Request an organization export or provide the backing marketplace repository" }
        ]
      }, parsed.json);
    }
    if (command === "snapshot") {
      requireOption(parsed.index, "--index");
      const index = await loadIndex(path.resolve(parsed.index));
      const snapshot = snapshotIndex(index, parsed.name ?? `generation-${index.generation}`);
      const outputPath = path.resolve(parsed.out ?? `skillmesh-snapshot-${index.generation}.json`);
      await writeFile(outputPath, stableStringify(snapshot));
      return outputResult(io, { snapshot: outputPath, generation: index.generation }, parsed.json);
    }
    if (command === "rollback") {
      requireOption(parsed.skill, "--skill");
      requireOption(parsed.snapshot, "--snapshot");
      requireOption(parsed.index, "--index");
      const snapshotArtifactRoot = parsed["snapshot-artifacts"] ?? parsed.artifacts;
      requireOption(snapshotArtifactRoot, "--snapshot-artifacts (or --artifacts)");
      const skillId = firstOption(parsed.skill);
      const snapshot = await readJson(path.resolve(parsed.snapshot));
      const prior = snapshot.skills?.[skillId];
      requireOption(prior, `skill ${skillId} in snapshot`);
      const indexPath = path.resolve(parsed.index);
      const current = await loadIndex(indexPath);
      const outputRoot = path.resolve(parsed.out ?? path.join(path.dirname(indexPath), "rollback-build"));
      const rewrapped = await rewrapRelease({
        priorRelease: { skillId, ...prior },
        buildRoot: path.resolve(snapshotArtifactRoot),
        outputRoot,
        providerRevision: (current.skills[skillId]?.providerRevision ?? 0) + 1
      });
      const rolledBack = rollbackSkill(current, skillId, rewrapped);
      await saveIndex(indexPath, rolledBack);
      return outputResult(io, { rolledBack: skillId, logicalVersion: rewrapped.logicalVersion, providerRevision: rewrapped.providerRevision, generation: rolledBack.generation, outputRoot }, parsed.json);
    }
    if (command === "restore") {
      requireOption(parsed.snapshot, "--snapshot");
      requireOption(parsed.index, "--index");
      const snapshotArtifactRoot = parsed["snapshot-artifacts"] ?? parsed.artifacts;
      const currentArtifactRoot = parsed["current-artifacts"] ?? parsed.artifacts;
      requireOption(snapshotArtifactRoot, "--snapshot-artifacts (or --artifacts)");
      const snapshot = await readJson(path.resolve(parsed.snapshot));
      const indexPath = path.resolve(parsed.index);
      const current = await loadIndex(indexPath);
      const outputRoot = path.resolve(parsed.out ?? path.join(path.dirname(indexPath), "restore-build"));
      const rewrapped = {};
      const removed = {};
      for (const [skillId, release] of Object.entries(snapshot.skills)) {
        rewrapped[skillId] = await rewrapRelease({
          priorRelease: { skillId, ...release },
          buildRoot: path.resolve(snapshotArtifactRoot),
          outputRoot,
          providerRevision: (current.skills[skillId]?.providerRevision ?? 0) + 1
        });
      }
      if (Object.keys(current.skills).some((id) => !snapshot.skills[id])) requireOption(currentArtifactRoot, "--current-artifacts (or --artifacts)");
      for (const [skillId, release] of Object.entries(current.skills).filter(([id]) => !snapshot.skills[id])) {
        removed[skillId] = await rewrapRelease({
          priorRelease: { skillId, ...release },
          buildRoot: path.resolve(currentArtifactRoot),
          outputRoot,
          providerRevision: release.providerRevision + 1,
          tombstone: true,
          lifecycle: { state: "removed", graceDays: 7, message: "Removed by snapshot restore after the standard safety grace period" }
        });
      }
      const restored = restoreSnapshot(current, snapshot, rewrapped, removed);
      await saveIndex(indexPath, restored);
      return outputResult(io, { restored: Object.keys(restored.skills), generation: restored.generation, outputRoot }, parsed.json);
    }
    if (command === "offboard") {
      const stateRoot = path.resolve(parsed.state ?? defaultStateRoot());
      const config = await readEndpointConfig(stateRoot);
      const index = await loadIndex(path.join(config.distributionCheckout, "stable-index.json"));
      return outputResult(io, await offboardEndpoint({
        config, index, stateRoot,
        credentialRevocation: parsed["credentials-revoked"]
          ? { state: "completed", evidence: "owner-confirmed" }
          : { state: "assisted-action-required", action: "Revoke repository credentials and GitHub/provider authorizations, then rerun with --credentials-revoked" }
      }), parsed.json);
    }
    if (command === "reenroll") {
      requireOption(parsed._[0], "repository pointer");
      const stateRoot = path.resolve(parsed.state ?? defaultStateRoot());
      const result = await reenroll(parsed._[0], { stateRoot, providerSync: reconcileClaudeCode });
      return outputResult(io, { repositorySwitched: result.repositorySwitched, complete: result.complete, sourceRepo: result.config.sourceRepo, previousRepos: result.previousRepos, validation: result.validation, orphanCleanup: result.orphanCleanup, pendingRetirements: result.pendingRetirements, pendingAccountBindings: result.pendingAccountBindings, credentialRevocation: result.credentialRevocation }, parsed.json);
    }
    io.error(`Unknown command: ${redact(command)}\n\n${usage()}`);
    return 2;
  } catch (error) {
    let incident = null;
    if (error.code === "SECURITY_BLOCK") incident = await recordSecurityIncident(error).catch(() => null);
    const recovery = incident ? `\nSecurity incident opened at ${incident}; credential assessment is required${error.details?.requiresHistoryRemediation ? " and Git history remediation is required before publication resumes" : ""}.` : "";
    io.error(`${error.code ? `${error.code}: ` : ""}${redact(error.message)}${recovery}`);
    return 1;
  }
}

async function recordSecurityIncident(error) {
  const root = path.join(process.cwd(), ".skillmesh", "security-incidents");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const incidentPath = path.join(root, `${timestamp}.json`);
  await writeFile(incidentPath, stableStringify({
    schemaVersion: 1,
    openedAt: new Date().toISOString(),
    publication: "blocked",
    credentialAssessment: "required-owner-action",
    historyRemediation: error.details?.requiresHistoryRemediation ? "required-before-resume" : "not-indicated-for-working-tree",
    revision: error.details?.revision ?? "unknown",
    findings: (error.details?.findings ?? []).map((finding) => ({ rule: finding.rule, location: finding.location, value: "[REDACTED]" }))
  }), { mode: 0o600 });
  return incidentPath;
}

function parseArgs(values) {
  const result = { _: [] };
  const booleans = new Set(["json", "dry-run-schedule", "scheduled", "replace", "allow-quarantine", "credentials-revoked"]);
  const repeatable = new Set(["project", "skill", "export"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { result._.push(value); continue; }
    const key = value.slice(2);
    if (booleans.has(key)) { result[key] = true; continue; }
    const next = values[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`Option --${key} requires a value`);
    if (repeatable.has(key)) (result[key] ??= []).push(next);
    else result[key] = next;
  }
  return result;
}

function requireOption(value, label) {
  if (!value) throw new Error(`${label} is required`);
}

function firstOption(value) {
  return Array.isArray(value) ? value[0] : value;
}

function output(io, value, code = 0) {
  io.log(value);
  return code;
}

function outputResult(io, value, json) {
  return output(io, json ? stableStringify(value).trimEnd() : summarize(value));
}

function summarize(value) {
  if (value.diagnosticComplete) return `Diagnostic complete: ${value.targets.filter((target) => target.state === "available").length}/${value.targets.length} targets available; ready=${value.ready}`;
  return stableStringify(value).trimEnd();
}

let invokedUrl = null;
if (process.argv[1]) {
  try { invokedUrl = pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { invokedUrl = pathToFileURL(process.argv[1]).href; }
}
if (import.meta.url === invokedUrl) {
  process.exitCode = await main();
}
