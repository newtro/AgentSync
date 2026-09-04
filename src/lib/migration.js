import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { invariant } from "./errors.js";
import { digestTree } from "./fs-tree.js";
import { runGit } from "./git.js";
import { stableStringify } from "./json.js";
import { isRfc3339Timestamp } from "./time.js";
import { validateManifest } from "./manifest.js";
import { scanBuffer } from "./security.js";

const CANDIDATE_TREES = Symbol("candidate-trees");
const CANDIDATE_MODES = Symbol("candidate-modes");
const CANDIDATE_FEATURES = Symbol("candidate-features");
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9-]*$/;
const SIMILARITY_THRESHOLD = 0.6;

export async function inventorySkills(roots) {
  invariant(Array.isArray(roots), "MIGRATION_ROOTS", "Migration roots must be an array");
  const copies = [];
  for (const source of roots) {
    invariant(typeof source?.name === "string" && source.name.trim(), "MIGRATION_SOURCE", "Every migration source needs a name");
    let entries;
    try {
      entries = await readdir(source.root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      invariant(!entry.isSymbolicLink(), "MIGRATION_SYMLINK", `Migration source contains a symlinked entry: ${source.name}/${entry.name}`);
      if (!entry.isDirectory()) continue;
      const directory = path.join(source.root, entry.name);
      try {
        await readFile(path.join(directory, "SKILL.md"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }

      const { files, modes } = await readMigrationTree(directory);
      const skillContent = files.get("SKILL.md");
      const text = skillContent.toString("utf8");
      const embeddedId = text.match(/^id:\s*([a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9-]*)\s*$/mi)?.[1];
      const digest = migrationTreeDigest(files, modes);
      const findings = dedupeFindings([...files].flatMap(([relative, content]) => scanBuffer(content, relative)));
      const slug = normalizeSlug(entry.name);
      const candidate = {
        candidateId: candidateId(source.name, entry.name, digest),
        source: source.name,
        directory,
        sourceName: entry.name,
        slug,
        embeddedId,
        digest,
        fileCount: files.size,
        totalBytes: [...files.values()].reduce((total, content) => total + content.length, 0),
        files: [...files].map(([relative, content]) => ({
          path: relative,
          digest: hashBuffer(content),
          size: content.length,
          executable: Boolean((modes.get(relative) ?? 0) & 0o111)
        })),
        security: findings.length ? "quarantined" : "clear",
        securityFindings: findings
      };
      candidate[CANDIDATE_TREES] = files;
      candidate[CANDIDATE_MODES] = modes;
      candidate[CANDIDATE_FEATURES] = similarityFeatures(files);
      copies.push(candidate);
    }
  }
  return copies.sort(compareCandidatesByIdentity);
}

export async function prepareMigration({ roots, stateRoot, now = new Date() }) {
  const copies = await inventorySkills(roots);
  const proposal = {
    schemaVersion: 2,
    createdAt: now.toISOString(),
    groups: groupCandidates(copies).map(({ key, basis, candidates }) => ({
      key,
      basis,
      status: candidates.some((item) => item.security === "quarantined")
        ? "secret-review-required"
        : candidates.length > 1 ? "merge-choice-required" : "ready-for-review",
      candidates: candidates.map(publicCandidate),
      comparisons: pairwiseComparisons(candidates),
      selectedCandidateId: null,
      selectedDigest: null,
      selection: null,
      import: null,
      replacementProof: null
    }))
  };
  const proposalRoot = path.join(stateRoot, "migration", now.toISOString().replace(/[:.]/g, "-"));
  await writeProposal(proposalRoot, proposal);
  return { proposal, proposalRoot };
}

export async function selectMigrationCandidate({ proposal, proposalRoot, groupKey, candidateId: selectedId, selectedBy, now = new Date() }) {
  validateProposal(proposal);
  invariant(typeof selectedBy === "string" && selectedBy.trim(), "MIGRATION_SELECTION", "Selection requires an explicit reviewer identity");
  const updated = structuredClone(proposal);
  const group = requireGroup(updated, groupKey);
  const candidate = group.candidates.find((item) => item.candidateId === selectedId);
  invariant(candidate, "MIGRATION_CANDIDATE", `Unknown migration candidate: ${selectedId}`);
  invariant(candidate.security === "clear", "MIGRATION_SECRET", "A quarantined candidate cannot be selected for import");
  group.selectedCandidateId = candidate.candidateId;
  group.selectedDigest = candidate.digest;
  group.selection = { selectedBy: selectedBy.trim(), selectedAt: now.toISOString() };
  group.import = null;
  group.replacementProof = null;
  group.status = "selected";
  if (proposalRoot) await writeProposal(proposalRoot, updated);
  return updated;
}

export async function stageMigrationImport({ proposal, proposalRoot, groupKey, now = new Date() }) {
  validateProposal(proposal);
  invariant(typeof proposalRoot === "string" && proposalRoot, "MIGRATION_IMPORT", "Import staging requires the proposal root");
  const updated = structuredClone(proposal);
  const group = requireGroup(updated, groupKey);
  invariant(group.selectedCandidateId && group.selectedDigest, "MIGRATION_SELECTION", "Select a migration candidate before staging an import");
  const candidate = group.candidates.find((item) => item.candidateId === group.selectedCandidateId);
  invariant(candidate?.security === "clear", "MIGRATION_SECRET", "A quarantined candidate cannot be staged for import");
  const tree = await readMigrationTree(candidate.sourcePath);
  invariant(migrationTreeDigest(tree.files, tree.modes) === candidate.digest, "MIGRATION_SOURCE_DRIFT", `Selected migration source changed after inventory: ${group.key}`);
  invariant(![...tree.files].flatMap(([relative, content]) => scanBuffer(content, relative)).length, "MIGRATION_SECRET", "Selected migration source contains a suspected credential");

  const importRoot = path.join(proposalRoot, "imports", encodeURIComponent(group.key), candidate.candidateId);
  const existingDigest = await digestIfDirectory(importRoot);
  if (existingDigest) {
    invariant(existingDigest === candidate.digest, "MIGRATION_IMPORT_CONFLICT", `A different staged import already exists: ${group.key}`);
  } else {
    const stage = `${importRoot}.stage-${randomUUID()}`;
    try {
      await writeTree(stage, tree.files, tree.modes);
      const stagedTree = await readMigrationTree(stage);
      invariant(migrationTreeDigest(stagedTree.files, stagedTree.modes) === candidate.digest, "MIGRATION_IMPORT_VERIFY", `Staged migration import failed verification: ${group.key}`);
      await mkdir(path.dirname(importRoot), { recursive: true, mode: 0o700 });
      await rename(stage, importRoot);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
  group.import = { state: "staged", path: importRoot, digest: candidate.digest, stagedAt: now.toISOString() };
  group.replacementProof = null;
  group.status = "import-staged";
  await writeProposal(proposalRoot, updated);
  return { proposal: updated, importRoot };
}

export async function recordMigrationPublication({ proposal, proposalRoot, groupKey, publication, now = new Date() }) {
  validateProposal(proposal);
  const updated = structuredClone(proposal);
  const group = requireGroup(updated, groupKey);
  invariant(group.import?.state === "staged" && group.selectedDigest === group.import.digest, "MIGRATION_IMPORT", "A verified staged selection is required before publication");
  invariant(publication?.selectedDigest === group.selectedDigest, "MIGRATION_PUBLICATION", "Publication is not bound to the selected legacy tree");
  invariant(DIGEST_PATTERN.test(publication.bundleDigest ?? ""), "MIGRATION_PUBLICATION", "Publication needs the verified bundle digest");
  invariant(typeof publication.branch === "string" && typeof publication.commit === "string" && publication.commit, "MIGRATION_PUBLICATION", "Publication needs its branch and commit");
  invariant(typeof publication.pullRequest === "string" && publication.pullRequest, "MIGRATION_PUBLICATION", "Publication needs its pull request URL");
  group.publication = { ...publication, publishedAt: now.toISOString() };
  group.replacementProof = null;
  group.status = "canonical-pr-open";
  if (proposalRoot) await writeProposal(proposalRoot, updated);
  return updated;
}

export async function recordCanonicalReplacementProof({ proposal, proposalRoot, groupKey, proof, now = new Date() }) {
  validateProposal(proposal);
  const updated = structuredClone(proposal);
  const group = requireGroup(updated, groupKey);
  invariant(group.import?.state === "staged", "MIGRATION_IMPORT", "Stage the selected migration import before recording replacement validation");
  invariant(group.publication, "MIGRATION_PUBLICATION", "Publish the canonical migration pull request before recording replacement validation");
  invariant(proof && typeof proof === "object", "MIGRATION_PROOF", "Canonical replacement proof is required");
  invariant(proof.selectedDigest === group.selectedDigest && proof.importDigest === group.import.digest, "MIGRATION_PROOF_BINDING", "Replacement proof does not match the selected staged import");
  invariant(SKILL_ID_PATTERN.test(proof.skillId ?? ""), "MIGRATION_PROOF", "Replacement proof needs a canonical namespaced skill id");
  const observed = await verifyReplacementEvidence(group, proof);
  invariant(DIGEST_PATTERN.test(observed.canonicalDigest), "MIGRATION_PROOF", "Replacement proof needs a canonical tree digest");
  invariant(typeof proof.logicalVersion === "string" && proof.logicalVersion, "MIGRATION_PROOF", "Replacement proof needs a logical version");
  invariant(typeof proof.sourceCommit === "string" && proof.sourceCommit, "MIGRATION_PROOF", "Replacement proof needs a source commit");
  const validation = observed.validation;
  const seenEndpoints = new Set();
  const endpoints = observed.endpoints.map((endpoint) => {
    invariant(typeof endpoint?.endpointId === "string" && endpoint.endpointId, "MIGRATION_PROOF", "Endpoint proof needs an endpoint id");
    invariant(!seenEndpoints.has(endpoint.endpointId), "MIGRATION_PROOF", `Duplicate endpoint proof: ${endpoint.endpointId}`);
    seenEndpoints.add(endpoint.endpointId);
    invariant(["validated", "pending", "unknown", "failed"].includes(endpoint.state), "MIGRATION_PROOF", `Unsupported endpoint proof state: ${endpoint.state}`);
    const normalized = { endpointId: endpoint.endpointId, state: endpoint.state };
    if (endpoint.reason) normalized.reason = String(endpoint.reason);
    return normalized;
  }).sort((a, b) => a.endpointId.localeCompare(b.endpointId));
  invariant(proof.validatedAt === undefined || isRfc3339Timestamp(proof.validatedAt), "MIGRATION_PROOF", "Replacement proof needs a valid RFC3339 validation timestamp");

  const proofCore = {
    skillId: proof.skillId,
    logicalVersion: proof.logicalVersion,
    sourceCommit: proof.sourceCommit,
    canonicalDigest: observed.canonicalDigest,
    selectedDigest: proof.selectedDigest,
    importDigest: proof.importDigest,
    validation,
    endpoints,
    evidence: observed.evidence,
    validatedAt: proof.validatedAt ? new Date(proof.validatedAt).toISOString() : now.toISOString()
  };
  invariant(isRfc3339Timestamp(proofCore.validatedAt), "MIGRATION_PROOF", "Replacement proof needs a valid RFC3339 validation timestamp");
  const gatesPassed = Object.values(validation).every((state) => state === "passed");
  const failedEndpoints = endpoints.filter((endpoint) => endpoint.state === "failed");
  const replacementProof = {
    ...proofCore,
    status: gatesPassed && !failedEndpoints.length ? "passed" : "failed",
    validatedEndpoints: endpoints.filter((endpoint) => endpoint.state === "validated"),
    pendingEndpoints: endpoints.filter((endpoint) => ["pending", "unknown"].includes(endpoint.state)),
    failedEndpoints,
    proofDigest: hashText(stableStringify(proofCore))
  };
  group.replacementProof = replacementProof;
  group.status = replacementProof.status === "passed" ? "ready-to-archive" : "replacement-validation-failed";
  if (proposalRoot) await writeProposal(proposalRoot, updated);
  return updated;
}

export function migrationProofDigest(proposal) {
  validateProposal(proposal);
  const proofSet = proposal.groups.map((group) => ({
    key: group.key,
    selectedCandidateId: group.selectedCandidateId,
    selectedDigest: group.selectedDigest,
    importDigest: group.import?.digest ?? null,
    publication: group.publication ?? null,
    replacementProofDigest: group.replacementProof?.proofDigest ?? null,
    replacementStatus: group.replacementProof?.status ?? null
  })).sort((a, b) => a.key.localeCompare(b.key));
  return hashText(stableStringify({ schemaVersion: proposal.schemaVersion, proofSet }));
}

async function verifyReplacementEvidence(group, proof) {
  const evidence = proof.evidence;
  invariant(evidence && typeof evidence === "object", "MIGRATION_EVIDENCE", "Replacement proof requires SkillMesh state evidence paths");
  const canonicalRoot = path.resolve(evidence.canonicalRoot ?? "");
  const distributionRoot = path.resolve(evidence.distributionRoot ?? "");
  const statusPath = path.resolve(evidence.statusPath ?? "");
  const stateRoot = path.resolve(evidence.stateRoot ?? "");
  invariant(statusPath === path.join(stateRoot, "status.json"), "MIGRATION_EVIDENCE", "Endpoint evidence must be the managed SkillMesh status file");
  const config = JSON.parse(await readFile(path.join(stateRoot, "config.json"), "utf8"));
  invariant(await realpath(config.distributionCheckout) === await realpath(distributionRoot), "MIGRATION_EVIDENCE", "Distribution evidence is not bound to the enrolled checkout");
  const sourceRepositoryRoot = path.resolve(await runGit(["rev-parse", "--show-toplevel"], { cwd: canonicalRoot }));
  const canonicalReal = await realpath(canonicalRoot);
  const sourceReal = await realpath(sourceRepositoryRoot);
  invariant(await realpath(config.sourceCheckout) === sourceReal, "MIGRATION_EVIDENCE", "Canonical evidence is not inside the enrolled source checkout");
  invariant(canonicalReal === sourceReal || canonicalReal.startsWith(`${sourceReal}${path.sep}`), "MIGRATION_EVIDENCE", "Canonical root escapes the source repository");
  invariant(await runGit(["rev-parse", "HEAD"], { cwd: sourceRepositoryRoot }) === proof.sourceCommit, "MIGRATION_EVIDENCE", "Source checkout HEAD does not match the promoted source commit");
  await runGit(["merge-base", "--is-ancestor", group.publication.commit, proof.sourceCommit], { cwd: sourceRepositoryRoot }).catch(() => invariant(false, "MIGRATION_EVIDENCE", "Recorded migration publication is not an ancestor of the promoted source commit"));
  const canonicalRelative = path.relative(sourceReal, canonicalReal) || ".";
  invariant(!(await runGit(["status", "--porcelain", "--", canonicalRelative], { cwd: sourceReal })), "MIGRATION_EVIDENCE", "Canonical evidence has uncommitted changes");
  const canonicalTree = await readMigrationTree(canonicalRoot);
  const canonicalDigest = migrationTreeDigest(canonicalTree.files, canonicalTree.modes);
  const manifest = validateManifest(JSON.parse(await readFile(path.join(canonicalRoot, "skill.json"), "utf8")));
  invariant(manifest.id === proof.skillId && manifest.version === proof.logicalVersion, "MIGRATION_EVIDENCE", "Canonical manifest does not match proof identity/version");
  invariant(![...canonicalTree.files].flatMap(([relative, content]) => scanBuffer(content, relative)).length, "MIGRATION_SECRET", "Canonical replacement contains a suspected credential");
  const index = JSON.parse(await readFile(path.join(distributionRoot, "stable-index.json"), "utf8"));
  const release = index.skills?.[proof.skillId];
  invariant(release?.logicalVersion === proof.logicalVersion && release.sourceCommit === proof.sourceCommit, "MIGRATION_EVIDENCE", "Stable release does not match proof identity/version/source commit");
  for (const artifact of Object.values(release.artifacts ?? {})) invariant(await digestTree(path.resolve(distributionRoot, artifact.path)) === artifact.digest, "MIGRATION_EVIDENCE", "Stable artifact digest verification failed");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  invariant(status.stableGeneration === index.generation, "MIGRATION_EVIDENCE", "Endpoint evidence is not for the current stable generation");
  invariant(isRfc3339Timestamp(status.updatedAt) && isRfc3339Timestamp(release.promotedAt) && Date.parse(status.updatedAt) >= Date.parse(release.promotedAt), "MIGRATION_EVIDENCE", "Endpoint evidence predates the promoted release");
  const records = (status.endpoints ?? status.statuses ?? []).filter((item) => item.skillId === proof.skillId);
  const expectedEndpointIds = new Set((config.enrollments ?? []).filter((enrollment) => release.artifacts?.[`${enrollment.harness}--${enrollment.os}--${enrollment.profile}--${enrollment.scope}`]).map((enrollment) => enrollment.id));
  invariant(expectedEndpointIds.size > 0 && records.length === expectedEndpointIds.size && records.every((item) => expectedEndpointIds.has(item.endpointId)), "MIGRATION_EVIDENCE", "Endpoint evidence does not exactly cover enrolled targets for the migrated skill");
  const endpoints = records.map((item) => ({
    endpointId: item.endpointId,
    state: item.state === "failed" ? "failed" : item.state === "installed" && item.active !== "unknown" ? "validated" : item.state === "installed" ? "pending" : "unknown",
    ...(item.reason ? { reason: item.reason } : {})
  }));
  return {
    canonicalDigest,
    validation: { canonical: "passed", security: "passed", artifacts: "passed" },
    endpoints,
    evidence: {
      canonicalRoot,
      distributionRoot,
      statusPath,
      stateRoot,
      stableGeneration: index.generation,
      stableIndexDigest: hashBuffer(await readFile(path.join(distributionRoot, "stable-index.json"))),
      endpointStatusDigest: hashBuffer(await readFile(statusPath)),
      publicationCommit: group.publication.commit,
      bundleDigest: group.publication.bundleDigest
    }
  };
}

export async function archiveMigrationOriginals({ proposal, proposalRoot, confirmation }) {
  validateProposal(proposal);
  invariant(confirmation && typeof confirmation === "object" && !Array.isArray(confirmation), "MIGRATION_CONFIRMATION", "Archival requires proof-bound owner confirmation");
  invariant(typeof confirmation.confirmedBy === "string" && confirmation.confirmedBy.trim(), "MIGRATION_CONFIRMATION", "Archival confirmation needs an owner identity");
  invariant(isRfc3339Timestamp(confirmation.confirmedAt), "MIGRATION_CONFIRMATION", "Archival confirmation needs an RFC3339 timestamp");
  const proofDigest = migrationProofDigest(proposal);
  invariant(confirmation.proofDigest === proofDigest, "MIGRATION_CONFIRMATION", "Archival confirmation does not match this validated migration proposal");
  for (const group of proposal.groups) {
    invariant(group.status === "ready-to-archive" && group.replacementProof?.status === "passed", "MIGRATION_VALIDATION", `Canonical replacement has not passed validation: ${group.key}`);
  }

  const sources = [];
  for (const group of proposal.groups) {
    for (const candidate of group.candidates) {
      const tree = await readMigrationTree(candidate.sourcePath);
      invariant(migrationTreeDigest(tree.files, tree.modes) === candidate.digest, "MIGRATION_SOURCE_DRIFT", `Migration source changed before archival: ${group.key}/${candidate.candidateId}`);
      sources.push({ candidate, tree });
    }
  }

  const archiveRoot = path.join(proposalRoot, "originals");
  const stageRoot = path.join(proposalRoot, `.originals-stage-${randomUUID()}`);
  try {
    await mkdir(stageRoot, { recursive: false, mode: 0o700 });
    for (const { candidate, tree } of sources) {
      const destination = path.join(stageRoot, encodeURIComponent(candidate.source), encodeURIComponent(candidate.slug || "skill"), candidate.candidateId);
      await writeTree(destination, tree.files, tree.modes);
    }
    const manifest = {
      schemaVersion: 1,
      archivedAt: new Date(confirmation.confirmedAt).toISOString(),
      confirmedBy: confirmation.confirmedBy.trim(),
      proofDigest,
      groups: proposal.groups.map((group) => ({
        key: group.key,
        canonicalSkillId: group.replacementProof.skillId,
        canonicalDigest: group.replacementProof.canonicalDigest,
        pendingEndpoints: group.replacementProof.pendingEndpoints,
        candidates: group.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          source: candidate.source,
          sourcePath: candidate.sourcePath,
          digest: candidate.digest
        }))
      }))
    };
    await writeFile(path.join(stageRoot, "archive-manifest.json"), stableStringify(manifest), { mode: 0o600 });
    await rename(stageRoot, archiveRoot);
    return { archiveRoot, manifestPath: path.join(archiveRoot, "archive-manifest.json"), proofDigest };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function groupCandidates(copies) {
  const embeddedGroups = new Map();
  const unembedded = [];
  for (const copy of copies) {
    if (!copy.embeddedId) unembedded.push(copy);
    else {
      if (!embeddedGroups.has(copy.embeddedId)) embeddedGroups.set(copy.embeddedId, []);
      embeddedGroups.get(copy.embeddedId).push(copy);
    }
  }

  const groups = [...embeddedGroups].map(([key, candidates]) => ({ key, basis: "embedded-id", candidates: candidates.sort(compareCandidatesByIdentity) }));
  const parents = unembedded.map((_, index) => index);
  const find = (index) => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const join = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
  };
  for (let left = 0; left < unembedded.length; left += 1) {
    for (let right = left + 1; right < unembedded.length; right += 1) {
      const sameSlug = unembedded[left].slug && unembedded[left].slug === unembedded[right].slug;
      const similar = similarity(unembedded[left], unembedded[right]) >= SIMILARITY_THRESHOLD;
      if (sameSlug || similar) join(left, right);
    }
  }
  const components = new Map();
  for (let index = 0; index < unembedded.length; index += 1) {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(unembedded[index]);
  }
  for (const candidates of components.values()) {
    candidates.sort(compareCandidatesByIdentity);
    const slugs = new Set(candidates.map((candidate) => candidate.slug));
    const basis = slugs.size === 1 ? "normalized-slug" : "content-similarity";
    const key = basis === "normalized-slug"
      ? candidates[0].slug
      : `similar-${hashText(candidates.map((candidate) => candidate.candidateId).join("\0")).slice(-16)}`;
    groups.push({ key, basis, candidates });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

function publicCandidate(candidate) {
  return {
    candidateId: candidate.candidateId,
    source: candidate.source,
    sourcePath: candidate.directory,
    sourceName: candidate.sourceName,
    slug: candidate.slug,
    embeddedId: candidate.embeddedId,
    digest: candidate.digest,
    fileCount: candidate.fileCount,
    totalBytes: candidate.totalBytes,
    files: candidate.files,
    security: candidate.security,
    securityFindings: candidate.securityFindings
  };
}

function pairwiseComparisons(candidates) {
  const comparisons = [];
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) comparisons.push(compareCandidateTrees(candidates[left], candidates[right]));
  }
  return comparisons;
}

function compareCandidateTrees(left, right) {
  const leftTree = left[CANDIDATE_TREES];
  const rightTree = right[CANDIDATE_TREES];
  const leftModes = left[CANDIDATE_MODES];
  const rightModes = right[CANDIDATE_MODES];
  const leftPaths = new Set(leftTree.keys());
  const rightPaths = new Set(rightTree.keys());
  const sameFiles = [];
  const changedFiles = [];
  for (const relative of [...leftPaths].filter((item) => rightPaths.has(item)).sort()) {
    const before = leftTree.get(relative);
    const after = rightTree.get(relative);
    const beforeMode = leftModes.get(relative);
    const afterMode = rightModes.get(relative);
    if (before.equals(after) && beforeMode === afterMode) sameFiles.push(relative);
    else changedFiles.push(changedFile(relative, before, after, beforeMode, afterMode));
  }
  return {
    leftCandidateId: left.candidateId,
    rightCandidateId: right.candidateId,
    similarity: similarity(left, right),
    sameFiles,
    addedFiles: [...rightPaths].filter((item) => !leftPaths.has(item)).sort(),
    removedFiles: [...leftPaths].filter((item) => !rightPaths.has(item)).sort(),
    changedFiles
  };
}

function changedFile(relative, before, after, beforeMode, afterMode) {
  const result = {
    path: relative,
    beforeDigest: hashBuffer(before),
    afterDigest: hashBuffer(after),
    beforeBytes: before.length,
    afterBytes: after.length,
    beforeMode,
    afterMode,
    kind: before.equals(after) ? "mode" : isUtf8Text(before) && isUtf8Text(after) ? "text" : "binary"
  };
  if (result.kind === "text") result.lineDelta = lineDelta(before.toString("utf8"), after.toString("utf8"));
  return result;
}

function lineDelta(before, after) {
  const left = before.replaceAll("\r\n", "\n").split("\n");
  const right = after.replaceAll("\r\n", "\n").split("\n");
  if (left.length * right.length > 1_000_000) return { omitted: "too-large" };
  let previous = new Uint32Array(right.length + 1);
  for (const leftLine of left) {
    const current = new Uint32Array(right.length + 1);
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = leftLine === right[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    previous = current;
  }
  const common = previous[right.length];
  return { added: right.length - common, removed: left.length - common };
}

async function readMigrationTree(root) {
  const rootStat = await lstat(root);
  invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "MIGRATION_SYMLINK", `Migration skill root must be a real directory: ${root}`);
  const files = new Map();
  const modes = new Map();
  await walkMigrationTree(root, "", files, modes);
  return { files, modes };
}

async function walkMigrationTree(root, relative, files, modes) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const portable = child.split(path.sep).join("/");
    invariant(!entry.isSymbolicLink(), "MIGRATION_SYMLINK", `Migration skill contains a symlink: ${portable}`);
    if (entry.isDirectory()) await walkMigrationTree(root, child, files, modes);
    else if (entry.isFile()) {
      const absolute = path.join(root, child);
      files.set(portable, await readFile(absolute));
      modes.set(portable, (await stat(absolute)).mode & 0o777);
    } else invariant(false, "MIGRATION_FILE", `Unsupported migration entry: ${portable}`);
  }
}

async function writeTree(root, files, modes) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [relative, content] of files) {
    const destination = containedPath(root, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { mode: modes.get(relative) ?? 0o600 });
  }
}

function similarity(left, right) {
  if (left.digest === right.digest) return 1;
  const a = left[CANDIDATE_FEATURES];
  const b = right[CANDIDATE_FEATURES];
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? Number((intersection / union).toFixed(4)) : 0;
}

function similarityFeatures(files) {
  const features = new Set();
  for (const [relative, content] of files) {
    features.add(hashText(`path:${relative.toLowerCase()}`));
    if (isUtf8Text(content)) {
      const words = content.toString("utf8").toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
      for (const word of new Set(words)) features.add(hashText(`word:${word}`));
    } else features.add(hashText(`binary:${relative}:${hashBuffer(content)}`));
  }
  return features;
}

function dedupeFindings(findings) {
  const seen = new Set();
  const result = [];
  for (const finding of findings) {
    const relative = finding.location.replace(/ \([^)]*-scan\)$/, "");
    const key = `${finding.rule}\0${relative}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ rule: finding.rule, path: relative });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
}

function candidateId(source, sourceName, digest) {
  return `candidate-${createHash("sha256").update(source).update("\0").update(sourceName).update("\0").update(digest).digest("hex").slice(0, 16)}`;
}

function compareCandidatesByIdentity(left, right) {
  return left.source.localeCompare(right.source) || left.sourceName.localeCompare(right.sourceName) || left.digest.localeCompare(right.digest);
}

function hashBuffer(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function migrationTreeDigest(files, modes) {
  const hash = createHash("sha256");
  for (const [relative, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(relative);
    hash.update("\0");
    hash.update(String(modes.get(relative) ?? 0));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function hashText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isUtf8Text(content) {
  return !content.includes(0) && Buffer.from(content.toString("utf8"), "utf8").equals(content);
}

function normalizeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function requireGroup(proposal, groupKey) {
  const group = proposal.groups.find((item) => item.key === groupKey);
  invariant(group, "MIGRATION_GROUP", `Unknown migration group: ${groupKey}`);
  return group;
}

function validateProposal(proposal) {
  invariant(proposal?.schemaVersion === 2 && Array.isArray(proposal.groups), "MIGRATION_SCHEMA", "Unsupported migration proposal schema");
}

async function writeProposal(proposalRoot, proposal) {
  await mkdir(proposalRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(proposalRoot, "proposal.json"), stableStringify(proposal), { mode: 0o600 });
}

async function digestIfDirectory(directory) {
  try {
    const tree = await readMigrationTree(directory);
    return migrationTreeDigest(tree.files, tree.modes);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function containedPath(root, relative) {
  invariant(typeof relative === "string" && !path.posix.isAbsolute(relative) && !relative.split("/").includes(".."), "MIGRATION_PATH", `Unsafe migration path: ${relative}`);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(root, ...relative.split("/"));
  invariant(absolute.startsWith(`${absoluteRoot}${path.sep}`), "MIGRATION_PATH", `Migration path escapes staging root: ${relative}`);
  return absolute;
}
