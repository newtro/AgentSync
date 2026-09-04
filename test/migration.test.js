import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveMigrationOriginals,
  migrationProofDigest,
  prepareMigration,
  recordCanonicalReplacementProof,
  recordMigrationPublication,
  selectMigrationCandidate,
  stageMigrationImport
} from "../src/lib/migration.js";
import { digestTree } from "../src/lib/fs-tree.js";

test("migration inventories and diffs entire divergent skill trees deterministically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-migrate-tree-"));
  const codex = path.join(root, "codex", "example");
  const claude = path.join(root, "claude", "Example");
  await mkdir(path.join(codex, "scripts"), { recursive: true });
  await mkdir(path.join(claude, "scripts"), { recursive: true });
  await mkdir(path.join(claude, "assets"), { recursive: true });
  await writeFile(path.join(codex, "SKILL.md"), "# First\nshared line\n");
  await writeFile(path.join(codex, "scripts", "run.js"), "console.log('first');\n");
  await writeFile(path.join(claude, "SKILL.md"), "# Second\nshared line\n");
  await writeFile(path.join(claude, "scripts", "run.js"), "console.log('second');\n");
  await writeFile(path.join(claude, "assets", "icon.bin"), Buffer.from([0, 1, 2]));
  const roots = [{ name: "codex", root: path.dirname(codex) }, { name: "claude", root: path.dirname(claude) }];
  const first = await prepareMigration({ roots, stateRoot: path.join(root, "state-a"), now: new Date("2026-01-01T00:00:00Z") });
  const second = await prepareMigration({ roots: [...roots].reverse(), stateRoot: path.join(root, "state-b"), now: new Date("2026-01-01T00:00:00Z") });
  assert.deepEqual(first.proposal.groups, second.proposal.groups);
  assert.equal(first.proposal.groups.length, 1);
  const group = first.proposal.groups[0];
  assert.equal(group.status, "merge-choice-required");
  assert.equal(group.selectedDigest, null);
  assert.equal(group.candidates[0].fileCount + group.candidates[1].fileCount, 5);
  assert.notEqual(group.candidates[0].digest, group.candidates[1].digest);
  assert.deepEqual([...group.comparisons[0].addedFiles, ...group.comparisons[0].removedFiles], ["assets/icon.bin"]);
  assert.deepEqual(group.comparisons[0].changedFiles.map((item) => item.path), ["SKILL.md", "scripts/run.js"]);
  assert.deepEqual(group.comparisons[0].changedFiles[0].lineDelta, { added: 1, removed: 1 });
});

test("whole-tree digest changes when a nested asset changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-migrate-digest-"));
  const skill = path.join(root, "skills", "example");
  await mkdir(path.join(skill, "assets"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Example\n");
  await writeFile(path.join(skill, "assets", "data.bin"), Buffer.from([1, 2, 3]));
  const before = await prepareMigration({ roots: [{ name: "legacy", root: path.dirname(skill) }], stateRoot: path.join(root, "state-a") });
  await writeFile(path.join(skill, "assets", "data.bin"), Buffer.from([1, 2, 4]));
  const after = await prepareMigration({ roots: [{ name: "legacy", root: path.dirname(skill) }], stateRoot: path.join(root, "state-b") });
  assert.notEqual(before.proposal.groups[0].candidates[0].digest, after.proposal.groups[0].candidates[0].digest);
});

test("migration scans scripts and assets and quarantines a secret outside SKILL.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-migrate-secret-"));
  const skill = path.join(root, "skills", "example");
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Safe instructions\n");
  await writeFile(path.join(skill, "scripts", "run.js"), `const key = "github_pat_${"A".repeat(30)}";\n`);
  const { proposal } = await prepareMigration({ roots: [{ name: "legacy", root: path.dirname(skill) }], stateRoot: path.join(root, "state") });
  const candidate = proposal.groups[0].candidates[0];
  assert.equal(proposal.groups[0].status, "secret-review-required");
  assert.equal(candidate.security, "quarantined");
  assert.deepEqual(candidate.securityFindings, [{ rule: "github-token", path: "scripts/run.js" }]);
  await assert.rejects(selectMigrationCandidate({ proposal, groupKey: proposal.groups[0].key, candidateId: candidate.candidateId, selectedBy: "owner" }), { code: "MIGRATION_SECRET" });
});

test("migration rejects symlinks anywhere inside a candidate tree", { skip: process.platform === "win32" && "Windows symlinks require an elevated test environment" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-migrate-link-"));
  const skill = path.join(root, "skills", "example");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Example\n");
  await symlink(path.join(root, "outside"), path.join(skill, "reference"));
  await assert.rejects(prepareMigration({ roots: [{ name: "legacy", root: path.dirname(skill) }], stateRoot: path.join(root, "state") }), { code: "MIGRATION_SYMLINK" });
});

test("content similarity groups renamed copies and emits deterministic comparison metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-migrate-similar-"));
  const first = path.join(root, "one", "review-tool");
  const second = path.join(root, "two", "quality-reviewer");
  for (const directory of [first, second]) {
    await mkdir(path.join(directory, "references"), { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "# Review code\nInspect correctness security privacy and failures.\n");
    await writeFile(path.join(directory, "references", "rules.md"), "Check rollback and recovery behavior.\n");
  }
  const { proposal } = await prepareMigration({
    roots: [{ name: "one", root: path.dirname(first) }, { name: "two", root: path.dirname(second) }],
    stateRoot: path.join(root, "state")
  });
  assert.equal(proposal.groups.length, 1);
  assert.equal(proposal.groups[0].basis, "content-similarity");
  assert.equal(proposal.groups[0].comparisons[0].similarity, 1);
  assert.deepEqual(proposal.groups[0].comparisons[0].sameFiles, ["SKILL.md", "references/rules.md"]);
});

test("selection, staging, proof, pending tracking, and archival are explicitly bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-migrate-flow-"));
  const skill = path.join(root, "skills", "example");
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Example\n");
  await writeFile(path.join(skill, "scripts", "run.js"), "console.log('safe');\n");
  let { proposal, proposalRoot } = await prepareMigration({
    roots: [{ name: "legacy", root: path.dirname(skill) }],
    stateRoot: path.join(root, "state"),
    now: new Date("2026-01-01T00:00:00Z")
  });
  const groupKey = proposal.groups[0].key;
  const candidate = proposal.groups[0].candidates[0];
  proposal = await selectMigrationCandidate({ proposal, proposalRoot, groupKey, candidateId: candidate.candidateId, selectedBy: "owner@example.test", now: new Date("2026-01-01T01:00:00Z") });
  const staged = await stageMigrationImport({ proposal, proposalRoot, groupKey, now: new Date("2026-01-01T02:00:00Z") });
  proposal = staged.proposal;
  assert.equal(await readFile(path.join(staged.importRoot, "scripts", "run.js"), "utf8"), "console.log('safe');\n");

  const sourceCheckout = path.join(root, "source-checkout");
  const canonicalRoot = path.join(sourceCheckout, "skills", "scott", "example");
  const distributionRoot = path.join(root, "distribution");
  const artifactRoot = path.join(distributionRoot, "artifacts", "example");
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(canonicalRoot, "SKILL.md"), "# Example\n");
  await writeFile(path.join(canonicalRoot, "skill.json"), JSON.stringify({ schemaVersion: 1, id: "scott/example", version: "1.0.0", displayName: "Example", description: "Example", files: ["SKILL.md"], targets: { required: [{ harness: "codex", os: "darwin", scope: "global" }] } }));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: sourceCheckout });
  spawnSync("git", ["config", "user.name", "SkillMesh Test"], { cwd: sourceCheckout });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceCheckout });
  spawnSync("git", ["add", "."], { cwd: sourceCheckout });
  spawnSync("git", ["commit", "-q", "-m", "Migrate example"], { cwd: sourceCheckout });
  const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceCheckout, encoding: "utf8" }).stdout.trim();
  proposal = await recordMigrationPublication({
    proposal, proposalRoot, groupKey,
    publication: { selectedDigest: candidate.digest, bundleDigest: `sha256:${"b".repeat(64)}`, branch: "skillmesh/migration", commit: sourceCommit, pullRequest: "https://example.test/pull/1" }
  });
  await writeFile(path.join(artifactRoot, "SKILL.md"), "generated\n");
  const managedStateRoot = path.join(root, "managed-state");
  const statusPath = path.join(managedStateRoot, "status.json");
  await mkdir(managedStateRoot);
  const enrollments = [
    { id: "mac-codex", harness: "codex", os: "darwin", profile: "default", scope: "global" },
    { id: "windows-claude", harness: "claude-code", os: "windows", profile: "personal", scope: "global" },
    { id: "claude-desktop", harness: "claude-desktop", os: "darwin", profile: "personal", scope: "global" }
  ];
  await writeFile(path.join(managedStateRoot, "config.json"), JSON.stringify({ sourceCheckout, distributionCheckout: distributionRoot, enrollments }));
  await writeFile(statusPath, JSON.stringify({ stableGeneration: 1, updatedAt: "2026-01-01T03:00:00Z", endpoints: [
    { endpointId: "mac-codex", skillId: "scott/example", state: "installed", active: true },
    { endpointId: "windows-claude", skillId: "scott/example", state: "installed", active: "unknown" },
    { endpointId: "claude-desktop", skillId: "scott/example", state: "unknown", reason: "provider-unobservable" }
  ] }));
  const writeStableIndex = async (digest) => writeFile(path.join(distributionRoot, "stable-index.json"), JSON.stringify({ generation: 1, skills: { "scott/example": { logicalVersion: "1.0.0", sourceCommit, promotedAt: "2026-01-01T02:30:00Z", artifacts: {
    "codex--darwin--default--global": { path: "artifacts/example", digest },
    "claude-code--windows--personal--global": { path: "artifacts/example", digest },
    "claude-desktop--darwin--personal--global": { path: "artifacts/example", digest }
  } } } }));
  await writeStableIndex(`sha256:${"0".repeat(64)}`);

  const commonProof = {
    skillId: "scott/example",
    logicalVersion: "1.0.0",
    sourceCommit,
    canonicalDigest: candidate.digest,
    selectedDigest: candidate.digest,
    importDigest: candidate.digest,
    evidence: { canonicalRoot, distributionRoot, statusPath, stateRoot: managedStateRoot },
    validatedAt: "2026-01-01T03:00:00Z"
  };
  await assert.rejects(recordCanonicalReplacementProof({ proposal, groupKey, proof: commonProof }), { code: "MIGRATION_EVIDENCE" });
  await writeStableIndex(await digestTree(artifactRoot));
  const fabricatedStatus = path.join(root, "fabricated-status.json");
  await writeFile(fabricatedStatus, JSON.stringify({ stableGeneration: 1, updatedAt: "2099-01-01T00:00:00Z", endpoints: [{ endpointId: "mac-codex", skillId: "scott/example", state: "installed", active: true }] }));
  await assert.rejects(recordCanonicalReplacementProof({ proposal, groupKey, proof: { ...commonProof, evidence: { ...commonProof.evidence, statusPath: fabricatedStatus } } }), { code: "MIGRATION_EVIDENCE" });
  await assert.rejects(recordCanonicalReplacementProof({ proposal, groupKey, proof: { ...commonProof, sourceCommit: "unrelated", mergedCommit: "unrelated" } }), { code: "MIGRATION_EVIDENCE" });
  await assert.rejects(recordCanonicalReplacementProof({ proposal, proposalRoot, groupKey, proof: { ...commonProof, validatedAt: "2026-09-04" } }), { code: "MIGRATION_PROOF" });

  proposal = await recordCanonicalReplacementProof({ proposal, proposalRoot, groupKey, proof: commonProof });
  assert.equal(proposal.groups[0].status, "ready-to-archive");
  assert.deepEqual(proposal.groups[0].replacementProof.validatedEndpoints.map((item) => item.endpointId), ["mac-codex"]);
  assert.deepEqual(proposal.groups[0].replacementProof.pendingEndpoints.map((item) => item.endpointId), ["claude-desktop", "windows-claude"]);
  await assert.rejects(archiveMigrationOriginals({ proposal, proposalRoot, confirmed: true }), { code: "MIGRATION_CONFIRMATION" });

  const proofDigest = migrationProofDigest(proposal);
  const archived = await archiveMigrationOriginals({
    proposal,
    proposalRoot,
    confirmation: { confirmedBy: "owner@example.test", confirmedAt: "2026-01-01T04:00:00Z", proofDigest }
  });
  const manifest = JSON.parse(await readFile(archived.manifestPath, "utf8"));
  assert.equal(manifest.proofDigest, proofDigest);
  assert.equal(manifest.groups[0].pendingEndpoints.length, 2);
  await access(path.join(skill, "SKILL.md"));
  await access(path.join(archived.archiveRoot, "legacy", "example", candidate.candidateId, "SKILL.md"));
});

test("staging refuses a selected source that drifted after inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-migrate-source-drift-"));
  const skill = path.join(root, "skills", "example");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Before\n");
  let { proposal, proposalRoot } = await prepareMigration({ roots: [{ name: "legacy", root: path.dirname(skill) }], stateRoot: path.join(root, "state") });
  const group = proposal.groups[0];
  proposal = await selectMigrationCandidate({ proposal, proposalRoot, groupKey: group.key, candidateId: group.candidates[0].candidateId, selectedBy: "owner" });
  await writeFile(path.join(skill, "SKILL.md"), "# After\n");
  await assert.rejects(stageMigrationImport({ proposal, proposalRoot, groupKey: group.key }), { code: "MIGRATION_SOURCE_DRIFT" });
});
