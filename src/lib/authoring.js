import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadCanonicalSkill } from "./compiler.js";
import { invariant } from "./errors.js";
import { runGit } from "./git.js";
import { stableStringify } from "./json.js";
import { validateManifest } from "./manifest.js";
import { assertSecure } from "./security.js";

export async function createChangeBundle(skillDirectory, outputPath) {
  const canonical = await loadCanonicalSkill(skillDirectory);
  const files = Object.fromEntries([...canonical.files].map(([relative, content]) => [relative, content.toString("base64")]));
  const payload = { schemaVersion: 1, manifest: canonical.manifest, files };
  const digest = `sha256:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
  const bundle = { ...payload, digest };
  await writeFile(outputPath, stableStringify(bundle), { mode: 0o600 });
  return bundle;
}

export async function applyChangeBundle(bundlePath, sourceRoot, options = {}) {
  const prepared = await readChangeBundle(bundlePath);
  return await applyPreparedBundle(prepared, sourceRoot, options);
}

export async function applyChangeBundleToBranch(bundlePath, sourceRoot, options = {}) {
  invariant(typeof options.publishPullRequest === "function", "PR_PUBLISHER_REQUIRED", "A pull request publisher is required for branch application");
  const prepared = await readChangeBundle(bundlePath);
  const git = options.runGit ?? runGit;
  const source = await realpath(sourceRoot);
  const repositoryRoot = await git(["rev-parse", "--show-toplevel"], { cwd: source });
  invariant(path.resolve(repositoryRoot) === path.resolve(source), "SOURCE_ROOT", "Cowork publish workflow requires the Git repository root");
  const dirty = await git(["status", "--porcelain"], { cwd: source });
  invariant(!dirty, "SOURCE_DIRTY", "Cowork publish workflow requires a clean source checkout");
  const baseBranch = options.baseBranch ?? await git(["branch", "--show-current"], { cwd: source });
  invariant(baseBranch, "BASE_BRANCH", "Cowork publish workflow requires a named base branch");

  const branch = options.branch ?? bundleBranch(prepared.manifest.id, prepared.digest);
  await git(["check-ref-format", "--branch", branch], { cwd: source });
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "skillmesh-cowork-pr-"));
  const checkout = path.join(stagingRoot, "checkout");
  try {
    await git(["clone", "--no-hardlinks", "--branch", baseBranch, "--single-branch", source, checkout], { cwd: stagingRoot });
    const upstream = await git(["remote", "get-url", "origin"], { cwd: source }).catch(() => null);
    if (upstream) await git(["remote", "set-url", "origin", upstream], { cwd: checkout });
    await git(["switch", "-c", branch], { cwd: checkout });

    const applied = await applyPreparedBundle(prepared, checkout, { replace: options.replace });
    const relativeDestination = path.relative(checkout, applied.destination).split(path.sep).join("/");
    await git(["add", "--", relativeDestination], { cwd: checkout });
    const changes = await git(["status", "--porcelain", "--", relativeDestination], { cwd: checkout });
    if (!changes) {
      return {
        ...applied,
        baseBranch,
        branch,
        commit: await git(["rev-parse", "HEAD"], { cwd: checkout }),
        noChanges: true,
        pullRequest: null
      };
    }

    await git(["commit", "-m", `Apply Cowork bundle for ${prepared.manifest.id}`], {
      cwd: checkout,
      env: {
        GIT_AUTHOR_NAME: "SkillMesh Cowork",
        GIT_AUTHOR_EMAIL: "skillmesh@localhost.invalid",
        GIT_COMMITTER_NAME: "SkillMesh Cowork",
        GIT_COMMITTER_EMAIL: "skillmesh@localhost.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
      }
    });
    const commit = await git(["rev-parse", "HEAD"], { cwd: checkout });
    const title = `Apply Cowork bundle for ${prepared.manifest.id}`;
    const body = `Applies verified Cowork bundle ${prepared.digest}.${options.bodyContext ? `\n\n${options.bodyContext}` : ""}`;
    const pullRequest = await options.publishPullRequest({
      sourceRoot: source,
      stagedRoot: checkout,
      baseBranch,
      branch,
      commit,
      digest: prepared.digest,
      skillId: prepared.manifest.id,
      title,
      body,
      retryKey: prepared.digest
    });
    return { ...applied, baseBranch, branch, commit, noChanges: false, pullRequest };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function readChangeBundle(bundlePath) {
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  invariant(bundle.schemaVersion === 1, "BUNDLE_SCHEMA", "Unsupported change bundle schema");
  const unsigned = Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "digest"));
  const digest = `sha256:${createHash("sha256").update(stableStringify(unsigned)).digest("hex")}`;
  invariant(digest === bundle.digest, "BUNDLE_DIGEST", "Change bundle digest mismatch");
  const manifest = validateManifest(bundle.manifest);
  const referenced = new Set(manifest.files.map((file) => file.source));
  for (const overlay of manifest.overlays) for (const file of overlay.files) referenced.add(file.source);
  invariant(bundle.files && typeof bundle.files === "object" && !Array.isArray(bundle.files), "BUNDLE_FILES", "Bundle files must be an object");
  invariant(Object.keys(bundle.files).length === referenced.size && [...referenced].every((file) => Object.hasOwn(bundle.files, file) && typeof bundle.files[file] === "string"), "BUNDLE_FILES", "Bundle does not exactly cover manifest source files");
  const decoded = [...referenced].map((file) => ({ path: file, content: Buffer.from(bundle.files[file], "base64") }));
  const metadata = Object.fromEntries(Object.entries(bundle).filter(([key]) => !["manifest", "files"].includes(key)));
  assertSecure([
    { path: "bundle/manifest.json", content: stableStringify(bundle.manifest) },
    { path: "bundle/metadata.json", content: stableStringify(metadata) },
    ...decoded.map((item) => ({ path: `bundle/files/${item.path}`, content: item.content }))
  ]);
  return { bundle, decoded, digest, manifest };
}

async function applyPreparedBundle(prepared, sourceRoot, options = {}) {
  const { bundle, decoded, digest, manifest } = prepared;
  const [namespace, name] = manifest.id.split("/");
  const safeParent = await ensureSafeSkillParent(sourceRoot, namespace);
  const destination = path.join(safeParent, name);
  try {
    const destinationStat = await lstat(destination);
    invariant(!destinationStat.isSymbolicLink() && destinationStat.isDirectory(), "BUNDLE_PATH_ESCAPE", `Canonical skill destination is not a real directory: ${manifest.id}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!options.replace) {
    try {
      await readFile(path.join(destination, "skill.json"));
      invariant(false, "BUNDLE_EXISTS", `Canonical skill already exists: ${manifest.id}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const stage = `${destination}.stage`;
  await rm(stage, { recursive: true, force: true });
  for (const item of decoded) {
    const output = path.join(stage, item.path);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, item.content);
  }
  await writeFile(path.join(stage, "skill.json"), stableStringify(bundle.manifest));
  const backup = `${destination}.previous`;
  let hadExisting = false;
  try {
    if (options.replace) {
      await rm(backup, { recursive: true, force: true });
      try { await rename(destination, backup); hadExisting = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await rename(stage, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (hadExisting) {
      await rm(destination, { recursive: true, force: true });
      await rename(backup, destination);
    }
    throw error;
  }
  return { skillId: manifest.id, destination, digest };
}

async function ensureSafeSkillParent(sourceRoot, namespace) {
  const lexicalSource = path.resolve(sourceRoot);
  await mkdir(lexicalSource, { recursive: true });
  const source = await realpath(lexicalSource);
  let current = lexicalSource;
  for (const segment of ["skills", namespace]) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      invariant(!entry.isSymbolicLink() && entry.isDirectory(), "BUNDLE_PATH_ESCAPE", `Canonical skill ancestor is not a real directory: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
    }
    const resolved = await realpath(current);
    invariant(resolved.startsWith(source + path.sep), "BUNDLE_PATH_ESCAPE", `Canonical skill ancestor escapes source repository: ${current}`);
  }
  return current;
}

function bundleBranch(skillId, digest) {
  const slug = skillId.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `skillmesh/cowork-${slug}-${digest.slice("sha256:".length, "sha256:".length + 12)}`;
}
