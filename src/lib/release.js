import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { compileProjection, digestFiles, providerSafeName, writeProjection } from "./compiler.js";
import { validateClaudePackage } from "./claude-validator.js";
import { readTree } from "./fs-tree.js";
import { invariant } from "./errors.js";
import { stableStringify } from "./json.js";
import { MAX_SKILL_ID_LENGTH, MAX_VERSION_LENGTH, VERSION_PATTERN, validateLifecycle, validateManifest, validateRelativePath } from "./manifest.js";
import { targetKey } from "./target.js";
import { isRfc3339Timestamp } from "./time.js";

export const INDEX_SCHEMA_VERSION = 1;

export function emptyStableIndex() {
  return { schemaVersion: INDEX_SCHEMA_VERSION, generation: 0, skills: {} };
}

export function assertNoUnsafeDeletions(skills, index) {
  const canonical = new Set(skills.map((skill) => skill.manifest.id));
  const missing = Object.entries(index.skills ?? {}).filter(([skillId, release]) => !canonical.has(skillId) && release.lifecycle?.state !== "removed").map(([skillId]) => skillId).sort();
  invariant(missing.length === 0, "SOURCE_SKILL_DELETED", `Canonical skills cannot be deleted while enabled; publish lifecycle state removed first: ${missing.join(", ")}`);
}

export async function buildCandidate(skill, outputRoot, sourceCommit = "working-tree", providerRevision = 1, validateClaude = validateClaudePackage) {
  const manifest = validateManifest(skill.manifest);
  const artifacts = {};
  const base = path.join(outputRoot, "artifacts", encodeSkillId(manifest.id), manifest.version);
  for (const target of manifest.targets.required) {
    const projection = compileProjection({ ...skill, manifest }, target, sourceCommit, providerRevision);
    const key = targetKey(target);
    const artifactRoot = path.join(base, key);
    await rm(artifactRoot, { recursive: true, force: true });
    await writeProjection(projection, artifactRoot);
    if (target.harness.startsWith("claude")) await validateClaude(artifactRoot);
    artifacts[key] = {
      digest: projection.digest,
      generatorVersion: projection.metadata.generatorVersion,
      payloadDigest: projection.metadata.payloadDigest,
      path: path.relative(outputRoot, artifactRoot).split(path.sep).join("/"),
      schemaVersion: projection.metadata.schemaVersion,
      target
    };
  }
  const sharedClaudePayloads = new Map();
  for (const artifact of Object.values(artifacts).filter((item) => item.target.harness.startsWith("claude"))) {
    const identity = providerSafeName(manifest.id, artifact.target);
    const previousPayload = sharedClaudePayloads.get(identity);
    invariant(!previousPayload || previousPayload === artifact.payloadDigest, "SHARED_STORAGE_CONFLICT", `Claude projections for ${manifest.id} conflict in shared plugin storage: ${identity}`);
    sharedClaudePayloads.set(identity, artifact.payloadDigest);
  }
  return {
    skillId: manifest.id,
    logicalVersion: manifest.version,
    sourceCommit,
    lifecycle: manifest.lifecycle,
    minimumUpdaterVersion: "0.1.0",
    artifacts,
    providerRevision,
    requiredTargets: manifest.targets.required.map(targetKey).sort(),
    deniedTargets: manifest.targets.denied.map(targetKey).sort(),
    validation: {
      security: "passed",
      targets: Object.fromEntries(manifest.targets.required.map((target) => [targetKey(target), "passed"]))
    }
  };
}

export async function buildRepositoryCandidates(skills, outputRoot, sourceCommit = "working-tree", revisionForSkill = () => 1, options = {}) {
  const candidates = [];
  const quarantined = [];
  for (const skill of skills) {
    try {
      const candidateSourceCommit = options.sourceCommitForSkill?.(skill.manifest.id, skill.manifest) ?? sourceCommit;
      candidates.push(await buildCandidate(skill, outputRoot, candidateSourceCommit, revisionForSkill(skill.manifest.id, skill.manifest), options.validateClaude ?? validateClaudePackage));
    } catch (error) {
      if (error.code === "SECURITY_BLOCK") throw error;
      try {
        const manifest = validateManifest(skill.manifest);
        await rm(path.join(outputRoot, "artifacts", encodeSkillId(manifest.id), manifest.version), { recursive: true, force: true });
      } catch {
        // Invalid manifests cannot have a safe, validated artifact path to clean.
      }
      quarantined.push({ skillId: skill.manifest.id, code: error.code ?? "BUILD_FAILED", message: error.message });
    }
  }
  const document = { schemaVersion: 1, sourceCommit, candidates, quarantined };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "candidates.json"), stableStringify(document));
  return document;
}

export function promoteCandidates(indexInput, candidateDocument, options = {}) {
  const index = structuredClone(indexInput ?? emptyStableIndex());
  invariant(index.schemaVersion === INDEX_SCHEMA_VERSION, "INDEX_SCHEMA", "Unsupported stable index schema");
  const selected = options.skillIds ? new Set(options.skillIds) : null;
  const promoted = [];
  for (const candidate of candidateDocument.candidates) {
    if (selected && !selected.has(candidate.skillId)) continue;
    validateCandidate(candidate);
    const previous = index.skills[candidate.skillId];
    if (previous?.logicalVersion === candidate.logicalVersion) {
      invariant(immutableReleaseShape(previous) === immutableReleaseShape(candidate), "LOGICAL_VERSION_IMMUTABLE", `Skill ${candidate.skillId} must advance its logical version when payload, target contract, or lifecycle changes`);
      invariant(candidate.providerRevision === undefined || candidate.providerRevision === previous.providerRevision, "PROVIDER_REVISION", `Unchanged skill ${candidate.skillId} must retain provider revision ${previous.providerRevision}`);
      continue;
    }
    if (previous) invariant(compareSemanticVersions(candidate.logicalVersion, previous.logicalVersion) > 0, "LOGICAL_VERSION_DOWNGRADE", `Normal promotion must advance the logical version for ${candidate.skillId}; use the explicit rollback or snapshot restore workflow`);
    const providerRevision = (previous?.providerRevision ?? 0) + 1;
    invariant(candidate.providerRevision === undefined || candidate.providerRevision === providerRevision, "PROVIDER_REVISION", `Candidate for ${candidate.skillId} was built for provider revision ${candidate.providerRevision}, expected ${providerRevision}`);
    index.skills[candidate.skillId] = {
      artifacts: candidate.artifacts,
      lifecycle: candidate.lifecycle,
      logicalVersion: candidate.logicalVersion,
      minimumUpdaterVersion: candidate.minimumUpdaterVersion,
      deniedTargets: candidate.deniedTargets ?? [],
      requiredTargets: candidate.requiredTargets,
      providerRevision,
      sourceCommit: candidate.sourceCommit,
      promotedAt: (options.now ?? new Date()).toISOString()
    };
    promoted.push(candidate.skillId);
  }
  if (promoted.length) index.generation += 1;
  validateStableIndex(index);
  return { index, promoted };
}

export function rollbackSkill(indexInput, skillId, priorRelease) {
  validateStableRelease(priorRelease, skillId);
  invariant(priorRelease.skillId === skillId, "ROLLBACK_SKILL", "Rollback release does not match requested skill");
  const index = structuredClone(indexInput);
  const current = index.skills[skillId];
  invariant(current, "ROLLBACK_UNKNOWN", `No active release for ${skillId}`);
  invariant(priorRelease.providerRevision === current.providerRevision + 1, "PROVIDER_REVISION", "Rollback candidate must be rewrapped at the next provider revision");
  index.skills[skillId] = {
    artifacts: priorRelease.artifacts,
    lifecycle: priorRelease.lifecycle,
    logicalVersion: priorRelease.logicalVersion,
    minimumUpdaterVersion: priorRelease.minimumUpdaterVersion,
    deniedTargets: priorRelease.deniedTargets ?? [],
    requiredTargets: priorRelease.requiredTargets,
    providerRevision: priorRelease.providerRevision,
    sourceCommit: priorRelease.sourceCommit,
    rollbackOf: current.logicalVersion
  };
  index.generation += 1;
  return index;
}

export async function rewrapRelease({ priorRelease, buildRoot, outputRoot, providerRevision, tombstone = false, lifecycle = priorRelease.lifecycle }) {
  invariant(Number.isSafeInteger(providerRevision) && providerRevision > priorRelease.providerRevision, "PROVIDER_REVISION", "Rewrapped release needs a higher provider revision");
  lifecycle = validateLifecycle(lifecycle);
  const artifacts = {};
  for (const [key, artifact] of Object.entries(priorRelease.artifacts)) {
    const sourceRoot = containedPath(buildRoot, artifact.path);
    const files = await readTree(sourceRoot);
    invariant(digestFiles(files) === artifact.digest, "DIGEST_MISMATCH", `Prior release artifact failed verification: ${key}`);
    const pluginPath = ".claude-plugin/plugin.json";
    if (files.has(pluginPath)) {
      const plugin = JSON.parse(files.get(pluginPath).toString("utf8"));
      plugin.version = `${providerRevision}.0.0`;
      files.set(pluginPath, Buffer.from(stableStringify(plugin)));
    }
    if (tombstone) {
      const skillPath = [...files.keys()].find((filePath) => filePath === "SKILL.md" || /^skills\/[^/]+\/SKILL\.md$/.test(filePath));
      invariant(skillPath, "SKILL_MISSING", `Prior release artifact has no SKILL.md: ${key}`);
      const original = files.get(skillPath).toString("utf8");
      const end = original.startsWith("---\n") ? original.indexOf("\n---\n", 4) : -1;
      invariant(end > 0, "SKILL_FRONTMATTER", `Prior release SKILL.md has no valid frontmatter: ${key}`);
      const frontmatter = original.slice(0, end + 5);
      files.set(skillPath, Buffer.from(`${frontmatter}\n# ${priorRelease.skillId} (removed)\n\nThis skill is disabled and must not perform its former behavior.\n`));
    }
    const metadataPath = "skillmesh-projection.json";
    if (files.has(metadataPath)) {
      const metadata = JSON.parse(files.get(metadataPath).toString("utf8"));
      metadata.providerRevision = providerRevision;
      metadata.lifecycle = lifecycle;
      const payload = new Map(files);
      payload.delete(metadataPath);
      metadata.payloadDigest = digestFiles(payload);
      files.set(metadataPath, Buffer.from(stableStringify(metadata)));
    }
    const relative = path.posix.join("artifacts", encodeSkillId(priorRelease.skillId), priorRelease.logicalVersion, `provider-${providerRevision}`, key);
    const projectionMetadata = files.has(metadataPath) ? JSON.parse(files.get(metadataPath).toString("utf8")) : undefined;
    await writeProjection({ files, metadata: projectionMetadata }, path.join(outputRoot, relative));
    artifacts[key] = { ...artifact, path: relative, digest: digestFiles(files), ...(projectionMetadata ? { payloadDigest: projectionMetadata.payloadDigest } : {}) };
  }
  return { ...structuredClone(priorRelease), artifacts, lifecycle, providerRevision };
}

export function snapshotIndex(index, name, createdAt = new Date().toISOString()) {
  const artifacts = Object.values(index.skills ?? {}).flatMap((release) => Object.values(release.artifacts ?? {}));
  return {
    schemaVersion: 1,
    name,
    createdAt,
    generation: index.generation,
    provenance: {
      artifactMaterial: "stable-distribution-content-addressed",
      generatorVersions: [...new Set(artifacts.map((artifact) => artifact.generatorVersion).filter(Boolean))].sort(),
      schemaVersions: [...new Set(artifacts.map((artifact) => artifact.schemaVersion).filter((value) => value !== undefined))].sort()
    },
    skills: structuredClone(index.skills)
  };
}

export function restoreSnapshot(indexInput, snapshot, rewrappedReleases, removedReleases = {}, now = new Date()) {
  invariant(snapshot.schemaVersion === 1, "SNAPSHOT_SCHEMA", "Unsupported snapshot schema");
  invariant(typeof snapshot.name === "string" && snapshot.name.length > 0 && isRfc3339Timestamp(snapshot.createdAt), "SNAPSHOT_SCHEMA", "Snapshot identity or creation timestamp is invalid");
  const index = structuredClone(indexInput);
  const restored = {};
  for (const [skillId, release] of Object.entries(snapshot.skills)) {
    const currentRevision = index.skills[skillId]?.providerRevision ?? 0;
    const rewrapped = rewrappedReleases?.[skillId];
    invariant(rewrapped, "SNAPSHOT_REWRAP", `Snapshot restore requires rewrapped artifacts for ${skillId}`);
    invariant(rewrapped.logicalVersion === release.logicalVersion, "SNAPSHOT_VERSION", `Rewrapped logical version mismatch for ${skillId}`);
    invariant(rewrapped.providerRevision === currentRevision + 1, "PROVIDER_REVISION", `Snapshot restore revision mismatch for ${skillId}`);
    restored[skillId] = {
      ...structuredClone(rewrapped),
      promotedAt: now.toISOString(),
      restoredFromSnapshot: snapshot.name
    };
  }
  for (const skillId of Object.keys(index.skills).filter((id) => !snapshot.skills[id])) {
    const currentRevision = index.skills[skillId].providerRevision ?? 0;
    const removed = removedReleases[skillId];
    invariant(removed, "SNAPSHOT_REMOVAL", `Snapshot restore requires a tombstone for post-snapshot skill ${skillId}`);
    invariant(removed.providerRevision === currentRevision + 1 && removed.lifecycle?.state === "removed", "SNAPSHOT_REMOVAL", `Invalid restore tombstone for ${skillId}`);
    restored[skillId] = { ...structuredClone(removed), promotedAt: now.toISOString(), restoredFromSnapshot: snapshot.name };
  }
  index.skills = restored;
  index.generation += 1;
  return index;
}

function validateStableRelease(release, skillId) {
  invariant(release && typeof release === "object", "RELEASE_INVALID", "Stable release must be an object");
  invariant(release.skillId === skillId, "ROLLBACK_SKILL", "Rollback release does not match requested skill");
  invariant(Number.isSafeInteger(release.providerRevision) && release.providerRevision > 0, "PROVIDER_REVISION", "Stable release needs a provider revision");
  invariant(Array.isArray(release.requiredTargets), "RELEASE_TARGETS", "Stable release lacks its target contract");
  invariant(JSON.stringify(Object.keys(release.artifacts ?? {}).sort()) === JSON.stringify([...release.requiredTargets].sort()), "RELEASE_COMPLETENESS", "Stable release artifacts do not cover its target contract");
  for (const artifact of Object.values(release.artifacts)) invariant(/^sha256:[a-f0-9]{64}$/.test(artifact.digest), "RELEASE_DIGEST", "Stable release has an invalid artifact digest");
}

export async function loadIndex(filePath) {
  try {
    return validateStableIndex(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyStableIndex();
    throw error;
  }
}

export async function loadUpdaterRelease(filePath) {
  const document = JSON.parse(await readFile(filePath, "utf8"));
  return document.updater === undefined ? undefined : validateUpdaterRelease(document.updater);
}

export function validateUpdaterRelease(updater) {
  invariant(updater && typeof updater === "object" && !Array.isArray(updater), "INDEX_UPDATER", "Updater release must be an object");
  const unknownUpdater = Object.keys(updater).filter((key) => !["version", "sourceCommit", "artifacts"].includes(key));
  invariant(unknownUpdater.length === 0, "INDEX_UPDATER", `Unknown updater release keys: ${unknownUpdater.join(", ")}`);
  invariant(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(updater.version ?? "") && updater.version.length <= MAX_VERSION_LENGTH, "INDEX_UPDATER", "Updater release version must be a bounded stable semantic version");
  invariant(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(updater.sourceCommit ?? ""), "INDEX_UPDATER", "Updater release needs an immutable full source commit");
  invariant(updater.artifacts && typeof updater.artifacts === "object" && !Array.isArray(updater.artifacts), "INDEX_UPDATER", "Updater platform artifacts are required");
  const platforms = Object.keys(updater.artifacts).sort();
  invariant(JSON.stringify(platforms) === JSON.stringify(["darwin", "win32"]), "INDEX_UPDATER", "Updater release must contain exact darwin and win32 artifacts");
  for (const artifact of Object.values(updater.artifacts)) {
    invariant(artifact && typeof artifact === "object" && Object.keys(artifact).every((key) => ["path", "digest"].includes(key)), "INDEX_UPDATER", "Updater artifact metadata is invalid");
    validateRelativePath(artifact.path);
    invariant(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ""), "INDEX_UPDATER", "Updater release digest is invalid");
  }
  return updater;
}

export function validateStableIndex(index) {
  invariant(index && typeof index === "object" && !Array.isArray(index), "INDEX_SCHEMA", "Stable index must be an object");
  const unknown = Object.keys(index).filter((key) => !["schemaVersion", "generation", "skills", "updater"].includes(key));
  invariant(unknown.length === 0, "INDEX_SCHEMA", `Unknown stable index keys: ${unknown.join(", ")}`);
  invariant(index.schemaVersion === INDEX_SCHEMA_VERSION, "INDEX_SCHEMA", "Unsupported stable index schema");
  invariant(Number.isSafeInteger(index.generation) && index.generation >= 0, "INDEX_GENERATION", "Stable index generation must be a non-negative integer");
  invariant(index.skills && typeof index.skills === "object" && !Array.isArray(index.skills), "INDEX_SKILLS", "Stable index skills must be an object");
  if (index.updater !== undefined) validateUpdaterRelease(index.updater);
  for (const [skillId, release] of Object.entries(index.skills)) {
    invariant(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9-]*$/.test(skillId) && skillId.length <= MAX_SKILL_ID_LENGTH, "INDEX_SKILL_ID", `Stable index contains an invalid or overlong skill id: ${skillId}`);
    const allowedRelease = new Set(["skillId", "logicalVersion", "sourceCommit", "providerRevision", "minimumUpdaterVersion", "requiredTargets", "deniedTargets", "lifecycle", "artifacts", "promotedAt", "rollbackOf", "restoredFromSnapshot"]);
    invariant(release && typeof release === "object" && Object.keys(release).every((key) => allowedRelease.has(key)), "INDEX_RELEASE", `Stable release has unknown metadata: ${skillId}`);
    invariant(VERSION_PATTERN.test(release.logicalVersion ?? "") && release.logicalVersion.length <= MAX_VERSION_LENGTH && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(release.sourceCommit ?? ""), "INDEX_RELEASE", `Stable release metadata or immutable source commit is invalid: ${skillId}`);
    invariant(release.skillId === undefined || release.skillId === skillId, "INDEX_RELEASE", `Stable release skill id does not match its index key: ${skillId}`);
    invariant(release.minimumUpdaterVersion === undefined || /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.minimumUpdaterVersion), "INDEX_RELEASE", `Stable release minimum updater version must be a stable semantic version: ${skillId}`);
    invariant(release.promotedAt === undefined || isRfc3339Timestamp(release.promotedAt), "INDEX_RELEASE", `Stable release promotion timestamp is invalid: ${skillId}`);
    invariant(release.rollbackOf === undefined || VERSION_PATTERN.test(release.rollbackOf), "INDEX_RELEASE", `Stable release rollback provenance is invalid: ${skillId}`);
    invariant(release.restoredFromSnapshot === undefined || (typeof release.restoredFromSnapshot === "string" && release.restoredFromSnapshot.length > 0), "INDEX_RELEASE", `Stable release snapshot provenance is invalid: ${skillId}`);
    invariant(Number.isSafeInteger(release.providerRevision) && release.providerRevision > 0, "INDEX_RELEASE", `Stable release provider revision is invalid: ${skillId}`);
    invariant(Array.isArray(release.requiredTargets), "INDEX_RELEASE", `Stable release target contract is missing: ${skillId}`);
    invariant(release.requiredTargets.every(validTargetKey) && new Set(release.requiredTargets).size === release.requiredTargets.length, "INDEX_RELEASE", `Stable release required targets are invalid: ${skillId}`);
    invariant(Array.isArray(release.deniedTargets ?? []) && (release.deniedTargets ?? []).every(validTargetKey) && new Set(release.deniedTargets ?? []).size === (release.deniedTargets ?? []).length, "INDEX_RELEASE", `Stable release denied targets are invalid: ${skillId}`);
    invariant(!(release.deniedTargets ?? []).some((key) => release.requiredTargets.includes(key)), "INDEX_RELEASE", `Stable release target cannot be required and denied: ${skillId}`);
    validateLifecycle(release.lifecycle);
    invariant(release.artifacts && typeof release.artifacts === "object" && !Array.isArray(release.artifacts), "INDEX_RELEASE", `Stable release artifacts are invalid: ${skillId}`);
    invariant(JSON.stringify(Object.keys(release.artifacts).sort()) === JSON.stringify([...release.requiredTargets].sort()), "INDEX_RELEASE", `Stable release artifacts do not exactly cover required targets: ${skillId}`);
    for (const [key, artifact] of Object.entries(release.artifacts)) {
      invariant(artifact && typeof artifact === "object" && Object.keys(artifact).every((field) => ["target", "path", "digest", "payloadDigest", "schemaVersion", "generatorVersion"].includes(field)), "INDEX_ARTIFACT", `Stable artifact has unknown metadata: ${skillId}/${key}`);
      invariant(key === targetKey(artifact.target), "INDEX_TARGET", `Stable artifact target mismatch: ${skillId}/${key}`);
      validateRelativePath(artifact.path);
      invariant(/^sha256:[a-f0-9]{64}$/.test(artifact.digest), "INDEX_ARTIFACT", `Stable artifact digest is invalid: ${skillId}/${key}`);
      invariant(artifact.schemaVersion === 1 && artifact.generatorVersion === "1" && /^sha256:[a-f0-9]{64}$/.test(artifact.payloadDigest ?? ""), "INDEX_ARTIFACT", `Stable artifact contract is unsupported: ${skillId}/${key}`);
    }
  }
  return index;
}

export function validateStableTransition(baseInput, nextInput) {
  const base = validateStableIndex(baseInput);
  const next = validateStableIndex(nextInput);
  invariant(next.generation >= base.generation, "INDEX_ROLLBACK", "Stable generation cannot decrease");
  let skillsChanged = false;
  for (const [skillId, prior] of Object.entries(base.skills)) {
    const current = next.skills[skillId];
    invariant(current, "INDEX_SKILL_REMOVED", `Stable skills cannot disappear from the distribution index: ${skillId}`);
    const changed = stableStringify(current) !== stableStringify(prior);
    if (!changed) continue;
    skillsChanged = true;
    invariant(current.providerRevision > prior.providerRevision, "PROVIDER_REVISION", `Changed stable skill must advance provider revision: ${skillId}`);
    if (current.logicalVersion === prior.logicalVersion) invariant(immutableReleaseShape(current) === immutableReleaseShape(prior) || validSnapshotTombstone(prior, current), "LOGICAL_VERSION_IMMUTABLE", `Changed payload, target contract, or lifecycle must advance the logical version: ${skillId}`);
    if (compareSemanticVersions(current.logicalVersion, prior.logicalVersion) < 0) invariant(current.rollbackOf === prior.logicalVersion || (typeof current.restoredFromSnapshot === "string" && current.restoredFromSnapshot.length > 0), "LOGICAL_VERSION_DOWNGRADE", `Logical version downgrade requires explicit rollback or snapshot provenance: ${skillId}`);
  }
  for (const skillId of Object.keys(next.skills)) if (!base.skills[skillId]) skillsChanged = true;
  if (skillsChanged) invariant(next.generation > base.generation, "INDEX_GENERATION", "A stable skill change must advance the distribution generation");
  if (base.updater) {
    invariant(next.updater, "INDEX_UPDATER", "The trusted updater release cannot disappear");
    const comparison = compareVersions(next.updater.version, base.updater.version);
    invariant(comparison >= 0, "INDEX_UPDATER", "Updater version cannot decrease");
    if (comparison === 0) invariant(stableStringify(next.updater) === stableStringify(base.updater), "INDEX_UPDATER", "Updater provenance or artifacts cannot change without a version increase");
  }
  return next;
}

function compareVersions(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

export function compareSemanticVersions(left, right) {
  invariant(VERSION_PATTERN.test(left) && VERSION_PATTERN.test(right), "VERSION_INVALID", "Cannot compare invalid semantic versions");
  const split = (value) => {
    const separator = value.indexOf("-");
    return separator < 0 ? [value, undefined] : [value.slice(0, separator), value.slice(separator + 1)];
  };
  const [leftCore, leftPre] = split(left);
  const [rightCore, rightPre] = split(right);
  const a = leftCore.split(".").map(BigInt);
  const b = rightCore.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  if (leftPre === undefined || rightPre === undefined) return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
    if (leftIds[index] === undefined || rightIds[index] === undefined) return leftIds[index] === undefined ? -1 : 1;
    if (leftIds[index] === rightIds[index]) continue;
    const leftNumeric = /^\d+$/.test(leftIds[index]);
    const rightNumeric = /^\d+$/.test(rightIds[index]);
    if (leftNumeric && rightNumeric) return BigInt(leftIds[index]) > BigInt(rightIds[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIds[index] > rightIds[index] ? 1 : -1;
  }
  return 0;
}

function immutableReleaseShape(release) {
  return stableStringify({
    sourceCommit: release.sourceCommit,
    minimumUpdaterVersion: release.minimumUpdaterVersion,
    requiredTargets: [...release.requiredTargets].sort(),
    deniedTargets: [...(release.deniedTargets ?? [])].sort(),
    lifecycle: release.lifecycle,
    artifacts: Object.fromEntries(Object.entries(release.artifacts).sort(([a], [b]) => a.localeCompare(b)))
  });
}

function validSnapshotTombstone(prior, current) {
  return typeof current.restoredFromSnapshot === "string"
    && current.restoredFromSnapshot.length > 0
    && prior.lifecycle?.state !== "removed"
    && current.lifecycle?.state === "removed"
    && stableStringify(current.requiredTargets) === stableStringify(prior.requiredTargets)
    && stableStringify(current.deniedTargets ?? []) === stableStringify(prior.deniedTargets ?? []);
}

function validTargetKey(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("--");
  if (parts.length !== 4) return false;
  try { return targetKey({ harness: parts[0], os: parts[1], profile: parts[2], scope: parts[3] }) === value; } catch { return false; }
}

export async function saveIndex(filePath, index) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stableStringify(index));
}

export function encodeSkillId(skillId) {
  return skillId.replace("/", "__");
}

function validateCandidate(candidate) {
  invariant(candidate && typeof candidate === "object", "CANDIDATE_INVALID", "Candidate must be an object");
  invariant(typeof candidate.skillId === "string", "CANDIDATE_ID", "Candidate skill id is required");
  invariant(Object.keys(candidate.artifacts ?? {}).length > 0, "CANDIDATE_ARTIFACTS", "Candidate has no artifacts");
  invariant(candidate.validation?.security === "passed", "CANDIDATE_SECURITY", "Candidate lacks a passing security result");
  invariant(Array.isArray(candidate.requiredTargets), "CANDIDATE_TARGETS", "Candidate lacks its required-target contract");
  const artifactKeys = Object.keys(candidate.artifacts).sort();
  invariant(JSON.stringify(artifactKeys) === JSON.stringify([...candidate.requiredTargets].sort()), "CANDIDATE_COMPLETENESS", "Candidate artifact set does not exactly cover required targets");
  for (const [key, artifact] of Object.entries(candidate.artifacts)) {
    invariant(key === targetKey(artifact.target), "CANDIDATE_TARGET", `Artifact target mismatch: ${key}`);
    invariant(/^sha256:[a-f0-9]{64}$/.test(artifact.digest), "CANDIDATE_DIGEST", `Invalid artifact digest: ${key}`);
    invariant(candidate.validation.targets?.[key] === "passed", "CANDIDATE_TARGET_VALIDATION", `Target validation did not pass: ${key}`);
  }
}

function containedPath(root, relative) {
  invariant(typeof relative === "string" && !path.posix.isAbsolute(relative) && !relative.split("/").includes(".."), "ARTIFACT_ESCAPE", `Unsafe artifact path: ${relative}`);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(root, ...relative.split("/"));
  invariant(absolute.startsWith(absoluteRoot + path.sep), "ARTIFACT_ESCAPE", `Artifact escapes build root: ${relative}`);
  return absolute;
}
