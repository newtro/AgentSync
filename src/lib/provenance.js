import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadCanonicalSkill } from "./compiler.js";
import { invariant } from "./errors.js";
import { runGit } from "./git.js";
import { stableStringify } from "./json.js";
import { buildCandidate } from "./release.js";

export async function validateDistributionProvenance({ sourceRoot, distributionRoot, index }) {
  const releasesByCommit = new Map();
  for (const [skillId, release] of Object.entries(index.skills)) {
    const entries = releasesByCommit.get(release.sourceCommit) ?? [];
    entries.push({ skillId, release });
    releasesByCommit.set(release.sourceCommit, entries);
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "skillmesh-provenance-"));
  try {
    await validateUpdaterProvenance({ sourceRoot, distributionRoot, updater: index.updater, temporaryRoot });
    for (const [sourceCommit, releases] of releasesByCommit) {
      const checkout = path.join(temporaryRoot, sourceCommit.replace(/[^a-fA-F0-9]/g, "_").slice(0, 64));
      const exists = await runGit(["cat-file", "-e", `${sourceCommit}^{commit}`], { cwd: sourceRoot }).then(() => true, () => false);
      const ancestor = exists && await runGit(["merge-base", "--is-ancestor", sourceCommit, "HEAD"], { cwd: sourceRoot }).then(() => true, () => false);
      invariant(ancestor, "SOURCE_PROVENANCE", `Stable source commit is not present on the trusted source branch: ${sourceCommit}`);
      await runGit(["worktree", "add", "--detach", checkout, sourceCommit], { cwd: sourceRoot });
      try {
        for (const { skillId, release } of releases) {
          const canonical = await loadCanonicalSkill(path.join(checkout, "skills", ...skillId.split("/")));
          invariant(canonical.manifest.id === skillId && canonical.manifest.version === release.logicalVersion, "SOURCE_PROVENANCE", `Stable release identity does not match trusted source: ${skillId}`);
          if (stableStringify(canonical.manifest.lifecycle) !== stableStringify(release.lifecycle)) {
            invariant(typeof release.restoredFromSnapshot === "string" && release.restoredFromSnapshot.length > 0 && canonical.manifest.lifecycle.state !== "removed" && release.lifecycle.state === "removed", "SOURCE_PROVENANCE", `Stable lifecycle does not match trusted source: ${skillId}`);
            canonical.manifest = { ...canonical.manifest, lifecycle: release.lifecycle };
          }
          const expected = await buildCandidate(canonical, path.join(temporaryRoot, "build"), sourceCommit, release.providerRevision);
          invariant(stableStringify(expected.lifecycle) === stableStringify(release.lifecycle), "SOURCE_PROVENANCE", `Stable lifecycle does not match trusted source: ${skillId}`);
          invariant(expected.minimumUpdaterVersion === release.minimumUpdaterVersion, "SOURCE_PROVENANCE", `Stable updater compatibility does not match trusted source: ${skillId}`);
          invariant(stableStringify(expected.requiredTargets) === stableStringify(release.requiredTargets) && stableStringify(expected.deniedTargets) === stableStringify(release.deniedTargets ?? []), "SOURCE_PROVENANCE", `Stable target contract does not match trusted source: ${skillId}`);
          for (const [key, artifact] of Object.entries(release.artifacts)) {
            const trusted = expected.artifacts[key];
            if (trusted && (release.rollbackOf || release.restoredFromSnapshot)) trusted.path = `artifacts/${skillId.replace("/", "__")}/${release.logicalVersion}/provider-${release.providerRevision}/${key}`;
            invariant(trusted && stableStringify(trusted) === stableStringify(artifact), "SOURCE_PROVENANCE", `Stable artifact descriptor does not reproduce from trusted source: ${skillId}/${key}`);
          }
        }
      } finally {
        await runGit(["worktree", "remove", "--force", checkout], { cwd: sourceRoot }).catch(() => null);
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return { updater: index.updater?.version ?? null, skills: Object.keys(index.skills).sort() };
}

async function validateUpdaterProvenance({ sourceRoot, distributionRoot, updater, temporaryRoot }) {
  if (!updater) return;
  const exists = await runGit(["cat-file", "-e", `${updater.sourceCommit}^{commit}`], { cwd: sourceRoot }).then(() => true, () => false);
  const ancestor = exists && await runGit(["merge-base", "--is-ancestor", updater.sourceCommit, "HEAD"], { cwd: sourceRoot }).then(() => true, () => false);
  invariant(ancestor, "SOURCE_PROVENANCE", `Updater source commit is not present on the trusted source branch: ${updater.sourceCommit}`);
  const checkout = path.join(temporaryRoot, "updater-source");
  await runGit(["worktree", "add", "--detach", checkout, updater.sourceCommit], { cwd: sourceRoot });
  try {
    const packageDocument = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
    invariant(packageDocument.version === updater.version, "SOURCE_PROVENANCE", "Updater version does not match trusted source package version");
    for (const [platform, artifact] of Object.entries(updater.artifacts)) {
      const name = platform === "win32" ? "skillmesh.cmd" : "skillmesh";
      const trusted = await readFile(path.join(checkout, "updater", platform, name));
      const published = await readFile(path.join(distributionRoot, artifact.path));
      invariant(trusted.equals(published), "SOURCE_PROVENANCE", `Updater artifact does not match trusted source: ${platform}`);
      invariant(`sha256:${createHash("sha256").update(trusted).digest("hex")}` === artifact.digest, "SOURCE_PROVENANCE", `Updater digest does not match trusted source: ${platform}`);
    }
  } finally {
    await runGit(["worktree", "remove", "--force", checkout], { cwd: sourceRoot }).catch(() => null);
  }
}
