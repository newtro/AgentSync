import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

import { invariant } from "./errors.js";
import { digestTree, readTree } from "./fs-tree.js";
import { stableStringify } from "./json.js";
import { validateRelativePath } from "./manifest.js";
import { providerSafeName } from "./compiler.js";
import { repositoryIdentity, runGit } from "./git.js";
import { scanRepository } from "./repo-security.js";
import { compareSemanticVersions, validateStableIndex } from "./release.js";
import { validateClaudePackage } from "./claude-validator.js";

export async function createDistributionStage({ sourceRoot, buildRoot, distributionRoot, index, stageUpdaterRelease = attachUpdaterRelease }) {
  await assertSeparateRepositories(sourceRoot, distributionRoot);
  const buildReal = await realpath(buildRoot);
  const distributionReal = await realpath(distributionRoot);
  const stage = path.join(distributionRoot, ".skillmesh-stage");
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, ".claude-plugin"), { recursive: true });
  index = await stageUpdaterRelease({ sourceRoot, stage, index: structuredClone(index) });
  const plugins = [];
  const pluginPayloads = new Map();
  for (const [skillId, release] of Object.entries(index.skills).sort(([a], [b]) => a.localeCompare(b))) {
    for (const artifact of Object.values(release.artifacts)) {
      validateRelativePath(artifact.path);
      let source = null;
      const buildSource = containedPath(buildRoot, artifact.path);
      try {
        const buildSourceReal = await realpath(buildSource);
        invariant(buildSourceReal.startsWith(buildReal + path.sep), "ARTIFACT_ESCAPE", `Artifact resolves outside build root: ${artifact.path}`);
        if (await digestTree(buildSource) === artifact.digest) source = buildSource;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!source) {
        source = containedPath(distributionRoot, artifact.path);
        const sourceReal = await realpath(source).catch((error) => {
          if (error.code === "ENOENT") invariant(false, "DIGEST_MISMATCH", `Neither candidate nor stable distribution matches artifact: ${artifact.path}`);
          throw error;
        });
        invariant(sourceReal.startsWith(distributionReal + path.sep) && !sourceReal.startsWith(`${await realpath(stage)}${path.sep}`), "ARTIFACT_ESCAPE", `Fallback artifact resolves outside stable distribution: ${artifact.path}`);
      }
      invariant(await digestTree(source) === artifact.digest, "DIGEST_MISMATCH", `Distribution source digest mismatch: ${artifact.path}`);
      const destination = containedPath(stage, artifact.path);
      await cp(source, destination, { recursive: true, errorOnExist: false });
      invariant(await digestTree(destination) === artifact.digest, "STAGE_VERIFY", `Distribution staged digest mismatch: ${artifact.path}`);
    }
    const claudeArtifacts = Object.values(release.artifacts).filter((item) => item.target.harness.startsWith("claude"));
    {
      for (const artifact of claudeArtifacts) {
        const manifestPath = path.join(containedPath(stage, artifact.path), ".claude-plugin", "plugin.json");
        const plugin = JSON.parse(await readFile(manifestPath, "utf8"));
        invariant(plugin.name === providerSafeName(skillId, artifact.target), "PLUGIN_IDENTITY", `Plugin identity mismatch: ${artifact.path}`);
        invariant(plugin.version === `${release.providerRevision}.0.0`, "PLUGIN_REVISION", `Plugin revision mismatch: ${artifact.path}`);
        const metadata = JSON.parse(await readFile(path.join(containedPath(stage, artifact.path), "skillmesh-projection.json"), "utf8"));
        invariant(metadata.logicalSkillId === skillId && metadata.targetKey === `${artifact.target.harness}--${artifact.target.os}--${artifact.target.profile}--${artifact.target.scope}`, "PLUGIN_TARGET", `Projection target mismatch: ${artifact.path}`);
        const observedPayload = await digestTree(containedPath(stage, artifact.path), { exclude: new Set(["skillmesh-projection.json"]) });
        invariant(metadata.payloadDigest === observedPayload, "PAYLOAD_DIGEST", `Projection payload metadata mismatch: ${artifact.path}`);
        const previousPayload = pluginPayloads.get(plugin.name);
        invariant(!previousPayload || previousPayload === metadata.payloadDigest, "SHARED_STORAGE_CONFLICT", `Account-specific Claude Code overlays conflict in shared plugin storage: ${skillId}`);
        if (!previousPayload) {
          pluginPayloads.set(plugin.name, metadata.payloadDigest);
          plugins.push({ name: plugin.name, source: `./${artifact.path}`, version: plugin.version, description: plugin.description });
        }
      }
    }
  }
  await writeFile(path.join(stage, "stable-index.json"), stableStringify(index));
  if (plugins.length) {
    await writeFile(path.join(stage, ".claude-plugin", "marketplace.json"), stableStringify({
      name: "skillmesh-stable",
      description: "Stable SkillMesh projections",
      owner: { name: "SkillMesh" },
      plugins
    }));
  } else await rm(path.join(stage, ".claude-plugin"), { recursive: true, force: true });
  await validateDistributionStage(stage);
  return {
    stage,
    providerRevision: Math.max(0, ...Object.values(index.skills).map((release) => release.providerRevision)),
    title: `Promote SkillMesh stable generation ${index.generation}`,
    body: "Generated stable-only artifacts. Merge this pull request to advance provider marketplaces."
  };
}

export async function publishDistributionPullRequest({ sourceRoot, distributionRoot, stage, generation, baseBranch, runGh = defaultGh, pushBranch = pushDistributionBranch, validateStage = validateDistributionStage }) {
  await assertSeparateRepositories(sourceRoot, distributionRoot);
  const stagedIndex = await validateStage(stage);
  invariant(stagedIndex.generation === generation, "GENERATION_MISMATCH", `Staged index generation ${stagedIndex.generation} does not match requested generation ${generation}`);
  await scanRepository(stage, `distribution-generation-${generation}`);
  const status = await runGit(["status", "--porcelain"], { cwd: distributionRoot });
  const dirty = status.split("\n").filter((line) => line && !line.slice(3).startsWith(".skillmesh-stage"));
  invariant(dirty.length === 0, "DISTRIBUTION_DIRTY", "Distribution repository must be clean before preparing a promotion branch");
  const updaterVersion = stagedIndex.updater?.version ?? "none";
  const branch = `skillmesh/promote-generation-${generation}-updater-${updaterVersion.replace(/[^0-9A-Za-z.-]/g, "-")}`;
  const base = baseBranch ?? await distributionBaseBranch(distributionRoot);
  await updateBaseBranch(distributionRoot, base);
  await runGit(["switch", "-C", branch, base], { cwd: distributionRoot });
  for (const relative of ["artifacts", "updater", ".claude-plugin", "stable-index.json"]) {
    await rm(path.join(distributionRoot, relative), { recursive: true, force: true });
  }
  await cp(stage, distributionRoot, { recursive: true, force: true });
  const publishPaths = ["artifacts", "stable-index.json"];
  for (const relative of ["updater", ".claude-plugin"]) {
    const exists = await realpath(path.join(distributionRoot, relative)).then(() => true, () => false);
    const tracked = await runGit(["ls-files", relative], { cwd: distributionRoot }).then((value) => Boolean(value), () => false);
    if (exists || tracked) publishPaths.push(relative);
  }
  await runGit(["add", "-A", "--", ...publishPaths], { cwd: distributionRoot });
  const staged = await runGit(["diff", "--cached", "--name-only"], { cwd: distributionRoot });
  if (staged) await runGit(["commit", "-m", `Promote SkillMesh generation ${generation}`], { cwd: distributionRoot });
  await pushBranch({ distributionRoot, branch });
  const title = `Promote SkillMesh stable generation ${generation}`;
  const body = "Generated stable-only artifacts. Merge this pull request to advance provider marketplaces.";
  const headCommit = await runGit(["rev-parse", "HEAD"], { cwd: distributionRoot });
  let existing = "";
  try { existing = await runGh(["pr", "view", branch, "--json", "url,headRefOid,state"], distributionRoot); } catch { /* no pull request exists yet */ }
  if (existing) {
    const record = JSON.parse(existing);
    invariant(record.headRefOid === headCommit && record.state === "OPEN" && typeof record.url === "string", "DISTRIBUTION_PR_COMMIT", "Existing distribution pull request does not match the staged publication commit");
    return { branch, baseBranch: base, title, url: record.url, resumed: true };
  }
  const url = await runGh(["pr", "create", "--base", base, "--title", title, "--body", body, "--head", branch], distributionRoot);
  return { branch, baseBranch: base, title, url };
}

export async function validateDistributionStage(stage, options = {}) {
  const stageReal = await realpath(stage);
  const index = validateStableIndex(JSON.parse(await readFile(path.join(stage, "stable-index.json"), "utf8")));
  const referencedRoots = [];
  const plugins = [];
  const pluginPayloads = new Map();
  for (const [skillId, release] of Object.entries(index.skills).sort(([a], [b]) => a.localeCompare(b))) {
    for (const artifact of Object.values(release.artifacts)) {
      validateRelativePath(artifact.path);
      const artifactRoot = containedPath(stage, artifact.path);
      const artifactReal = await realpath(artifactRoot);
      invariant(artifactReal.startsWith(stageReal + path.sep), "ARTIFACT_ESCAPE", `Staged artifact resolves outside distribution: ${artifact.path}`);
      invariant(await digestTree(artifactRoot) === artifact.digest, "DIGEST_MISMATCH", `Staged artifact digest mismatch: ${artifact.path}`);
      const metadata = JSON.parse(await readFile(path.join(artifactRoot, "skillmesh-projection.json"), "utf8"));
      invariant(metadata.schemaVersion === artifact.schemaVersion && metadata.generatorVersion === artifact.generatorVersion, "ARTIFACT_SCHEMA", `Staged projection contract mismatch: ${artifact.path}`);
      invariant(metadata.logicalSkillId === skillId && metadata.logicalVersion === release.logicalVersion && metadata.providerRevision === release.providerRevision && metadata.sourceCommit === release.sourceCommit && stableStringify(metadata.lifecycle) === stableStringify(release.lifecycle), "ARTIFACT_METADATA", `Staged projection release metadata mismatch: ${artifact.path}`);
      invariant(metadata.targetKey === `${artifact.target.harness}--${artifact.target.os}--${artifact.target.profile}--${artifact.target.scope}`, "ARTIFACT_METADATA", `Staged projection target metadata mismatch: ${artifact.path}`);
      const observedPayload = await digestTree(artifactRoot, { exclude: new Set(["skillmesh-projection.json"]) });
      invariant(observedPayload === artifact.payloadDigest && metadata.payloadDigest === artifact.payloadDigest, "PAYLOAD_DIGEST", `Staged projection payload mismatch: ${artifact.path}`);
      referencedRoots.push(`${artifact.path}/`);
      if (artifact.target.harness.startsWith("claude")) {
        const plugin = JSON.parse(await readFile(path.join(artifactRoot, ".claude-plugin", "plugin.json"), "utf8"));
        const expectedName = providerSafeName(skillId, artifact.target);
        invariant(plugin.name === expectedName && plugin.version === `${release.providerRevision}.0.0`, "PLUGIN_IDENTITY", `Staged Claude plugin metadata mismatch: ${artifact.path}`);
        const previous = pluginPayloads.get(plugin.name);
        invariant(!previous || previous === artifact.payloadDigest, "SHARED_STORAGE_CONFLICT", `Staged Claude projections conflict in shared plugin storage: ${skillId}`);
        if (!previous) plugins.push({ name: plugin.name, source: `./${artifact.path}`, version: plugin.version, description: plugin.description });
        pluginPayloads.set(plugin.name, artifact.payloadDigest);
        await validateClaudePackage(artifactRoot);
      }
    }
  }
  if (index.updater) {
    for (const artifact of Object.values(index.updater.artifacts)) {
      const updaterPath = containedPath(stage, artifact.path);
      const updaterReal = await realpath(updaterPath);
      invariant(updaterReal.startsWith(stageReal + path.sep), "ARTIFACT_ESCAPE", `Updater artifact resolves outside distribution: ${artifact.path}`);
      const digest = `sha256:${createHash("sha256").update(await readFile(updaterPath)).digest("hex")}`;
      invariant(digest === artifact.digest, "UPDATER_DIGEST", `Staged updater artifact digest mismatch: ${artifact.path}`);
      referencedRoots.push(artifact.path);
    }
  }
  const marketplacePath = path.join(stage, ".claude-plugin", "marketplace.json");
  if (plugins.length) {
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
    invariant(stableStringify(marketplace) === stableStringify({ name: "skillmesh-stable", description: "Stable SkillMesh projections", owner: { name: "SkillMesh" }, plugins }), "MARKETPLACE_MISMATCH", "Staged Claude marketplace does not exactly match stable artifacts");
    await validateClaudePackage(marketplacePath);
  } else invariant(!await realpath(marketplacePath).then(() => true, () => false), "MARKETPLACE_MISMATCH", "An empty Claude marketplace is not provider-valid and must be absent");
  const isReferenced = (file) => file === "stable-index.json" || file === ".claude-plugin/marketplace.json" || referencedRoots.some((root) => file === root || file.startsWith(root.endsWith("/") ? root : `${root}/`));
  if (options.stageOnly !== false) {
    const tree = await readTree(stage);
    for (const file of tree.keys()) invariant(isReferenced(file), "UNREFERENCED_ARTIFACT", `Distribution contains unreferenced content: ${file}`);
  } else {
    const allowedTopLevel = new Set([".git", ".github", ".gitignore", "README.md", "stable-index.json", "artifacts", "updater", ".claude-plugin"]);
    for (const entry of await readdir(stage, { withFileTypes: true })) invariant(allowedTopLevel.has(entry.name) && !entry.isSymbolicLink(), "UNREFERENCED_ARTIFACT", `Distribution contains unreferenced top-level content: ${entry.name}`);
    for (const relativeRoot of ["artifacts", "updater", ".claude-plugin"]) {
      const contentRoot = path.join(stage, relativeRoot);
      if (!await realpath(contentRoot).then(() => true, () => false)) continue;
      const tree = await readTree(contentRoot);
      for (const file of tree.keys()) {
        const relative = `${relativeRoot}/${file}`;
        invariant(isReferenced(relative), "UNREFERENCED_ARTIFACT", `Distribution contains unreferenced content: ${relative}`);
      }
    }
  }
  return index;
}

async function attachUpdaterRelease({ sourceRoot, stage, index }) {
  const contract = await validateSourceUpdaterContract({ sourceRoot, index });
  for (const [platform, name] of [["darwin", "skillmesh"], ["win32", "skillmesh.cmd"]]) {
    const source = path.join(sourceRoot, "updater", platform, name);
    const destinationRelative = contract.release.artifacts[platform].path;
    const destination = path.join(stage, ...destinationRelative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  index.updater = contract.release;
  return index;
}

export async function validateSourceUpdaterContract({ sourceRoot, index }) {
  const packageDocument = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const version = packageDocument.version;
  invariant(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), "UPDATER_VERSION_SOURCE", "Updater source version must be a stable semantic version");
  const versionSource = await readFile(path.join(sourceRoot, "src", "lib", "version.js"), "utf8");
  const match = /^export const CURRENT_VERSION = "((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))";\s*$/.exec(versionSource);
  invariant(match && match[1] === version, "UPDATER_VERSION_SOURCE", `package.json version ${version} must exactly match the declarative runtime version source`);
  const artifacts = {};
  for (const [platform, name] of [["darwin", "skillmesh"], ["win32", "skillmesh.cmd"]]) {
    const bytes = await readFile(path.join(sourceRoot, "updater", platform, name));
    artifacts[platform] = { path: `updater/${version}/${platform}/${name}`, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  }
  const prior = index.updater;
  if (prior) {
    const comparison = compareSemanticVersions(version, prior.version);
    invariant(comparison >= 0, "UPDATER_VERSION_DOWNGRADE", `Updater source version ${version} cannot be older than stable ${prior.version}`);
    if (comparison === 0) {
      invariant(stableStringify(artifacts) === stableStringify(prior.artifacts), "UPDATER_VERSION_REQUIRED", "Updater templates changed without a package and runtime version increase");
      return { changed: false, release: structuredClone(prior) };
    }
  }
  const sourceCommit = await runGit(["rev-parse", "HEAD"], { cwd: sourceRoot });
  invariant(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit), "UPDATER_SOURCE_COMMIT", "Updater publication requires a full immutable source commit");
  return { changed: true, release: { version, sourceCommit, artifacts } };
}

async function pushDistributionBranch({ distributionRoot, branch }) {
  const remoteBranch = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  await runGit(["fetch", "origin", `${remoteBranch}:${remoteRef}`], { cwd: distributionRoot }).catch(() => null);
  const remoteSha = await runGit(["rev-parse", "--verify", remoteRef], { cwd: distributionRoot }).catch(() => "");
  await runGit(["push", `--force-with-lease=${remoteBranch}:${remoteSha}`, "--set-upstream", "origin", `HEAD:${remoteBranch}`], { cwd: distributionRoot });
}

async function distributionBaseBranch(root) {
  const remoteHead = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root }).catch(() => "");
  if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  for (const candidate of ["main", "master"]) {
    if (await runGit(["rev-parse", "--verify", `refs/heads/${candidate}`], { cwd: root }).then(() => true, () => false)) return candidate;
  }
  return await runGit(["branch", "--show-current"], { cwd: root });
}

async function updateBaseBranch(root, base) {
  invariant(base, "BASE_BRANCH", "Distribution repository needs a named stable base branch");
  const fetched = await runGit(["fetch", "origin", base], { cwd: root }).then(() => true, () => false);
  await runGit(["switch", base], { cwd: root });
  if (fetched) await runGit(["merge", "--ff-only", `origin/${base}`], { cwd: root });
}

export async function publishSourcePullRequest({ stagedRoot, baseBranch, branch, commit, title, body }, runGh = defaultGh) {
  invariant(commit && await runGit(["rev-parse", "HEAD"], { cwd: stagedRoot }) === commit, "SOURCE_PR_COMMIT", "Prepared source pull request commit no longer matches its staged checkout");
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteBranch = `refs/heads/${branch}`;
  await runGit(["fetch", "origin", `${remoteBranch}:${remoteRef}`], { cwd: stagedRoot }).catch(() => null);
  const remoteSha = await runGit(["rev-parse", "--verify", remoteRef], { cwd: stagedRoot }).catch(() => "");
  invariant(!remoteSha || remoteSha === commit, "SOURCE_PR_COMMIT", "Existing Cowork publication branch does not match the prepared bundle commit");
  if (remoteSha) {
    let existing = "";
    try { existing = await runGh(["pr", "view", branch, "--json", "url,headRefOid,state"], stagedRoot); } catch { /* no PR yet */ }
    if (existing) {
      const record = JSON.parse(existing);
      invariant(record.headRefOid === commit && record.state === "OPEN" && typeof record.url === "string", "SOURCE_PR_COMMIT", "Existing Cowork pull request does not match the prepared bundle commit");
      return { url: record.url, resumed: true };
    }
  }
  const lease = `--force-with-lease=${remoteBranch}:${remoteSha}`;
  await runGit(["push", lease, "--set-upstream", "origin", `HEAD:${remoteBranch}`], { cwd: stagedRoot });
  const url = await runGh(["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body", body], stagedRoot);
  return { url, resumed: false };
}

function defaultGh(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`GitHub pull request creation failed: ${stderr.trim()}`)));
  });
}

export async function assertSeparateRepositories(sourceRoot, distributionRoot) {
  const source = await gitRepositoryIdentity(sourceRoot);
  const distribution = await gitRepositoryIdentity(distributionRoot);
  invariant(source.root !== distribution.root, "DISTRIBUTION_BOUNDARY", "Source and distribution must be separate Git repositories");
  invariant(!source.remote || !distribution.remote || repositoryIdentity(source.remote) !== repositoryIdentity(distribution.remote), "DISTRIBUTION_BOUNDARY", "Source and distribution repositories must not use the same origin");
}

async function gitRepositoryIdentity(value) {
  const root = await git(value, ["rev-parse", "--show-toplevel"]);
  invariant(root, "GIT_REPOSITORY_REQUIRED", `Not inside a Git repository: ${value}`);
  const remote = await git(value, ["remote", "get-url", "origin"], true);
  return { root: await realpath(root), remote: remote || null };
}

function git(cwd, args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else if (allowFailure) resolve("");
      else reject(new Error(`git ${args[0]} failed`));
    });
  });
}

function containedPath(root, relative) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(root, ...relative.split("/"));
  invariant(absolute.startsWith(absoluteRoot + path.sep), "ARTIFACT_ESCAPE", `Artifact escapes root: ${relative}`);
  return absolute;
}
