import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyChangeBundle, applyChangeBundleToBranch, createChangeBundle } from "../src/lib/authoring.js";
import { publishSourcePullRequest } from "../src/lib/publisher.js";
import { stableStringify } from "../src/lib/json.js";

test("Cowork fallback bundle preserves a canonical change without reauthoring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-bundle-"));
  const skill = path.join(root, "draft");
  await mkdir(skill);
  await writeFile(path.join(skill, "SKILL.md"), "# Bundle\n");
  await writeFile(path.join(skill, "skill.json"), JSON.stringify({
    schemaVersion: 1, id: "scott/bundle", version: "1.0.0", displayName: "Bundle", description: "Bundle fixture", files: ["SKILL.md"],
    targets: { required: [{ harness: "codex", os: "darwin", profile: "default", scope: "global" }] }
  }));
  const bundlePath = path.join(root, "change.skillmesh.json");
  await createChangeBundle(skill, bundlePath);
  const applied = await applyChangeBundle(bundlePath, path.join(root, "source"));
  assert.equal(applied.skillId, "scott/bundle");
  assert.equal(await readFile(path.join(applied.destination, "SKILL.md"), "utf8"), "# Bundle\n");
});

test("tampered bundles are rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-bundle-bad-"));
  const bundlePath = path.join(root, "bad.json");
  await writeFile(bundlePath, JSON.stringify({ schemaVersion: 1, manifest: {}, files: {}, digest: `sha256:${"0".repeat(64)}` }));
  await assert.rejects(applyChangeBundle(bundlePath, path.join(root, "source")), { code: "BUNDLE_DIGEST" });
});

test("bundle application rejects a symlinked canonical ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-bundle-symlink-"));
  const draft = path.join(root, "draft");
  const source = path.join(root, "source");
  const outside = path.join(root, "outside");
  await mkdir(draft);
  await mkdir(source);
  await mkdir(path.join(source, "skills"));
  await mkdir(outside);
  await symlink(outside, path.join(source, "skills", "scott"));
  await writeFile(path.join(draft, "SKILL.md"), "# Safe\n");
  await writeFile(path.join(draft, "skill.json"), JSON.stringify(fixtureManifest()));
  const bundlePath = path.join(root, "change.json");
  await createChangeBundle(draft, bundlePath);
  await assert.rejects(applyChangeBundle(bundlePath, source), { code: "BUNDLE_PATH_ESCAPE" });
  await assert.rejects(readFile(path.join(outside, "bundle", "SKILL.md")));
});

test("bundle application scans secrets in the manifest and metadata before writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-bundle-secret-"));
  const token = "ghp_" + "a".repeat(24);
  const manifestBundle = signedBundle({
    schemaVersion: 1,
    manifest: fixtureManifest({ description: `Leaked ${token}` }),
    files: { "SKILL.md": Buffer.from("# Safe\n").toString("base64") }
  });
  const manifestPath = path.join(root, "manifest-secret.json");
  await writeFile(manifestPath, stableStringify(manifestBundle));
  const source = path.join(root, "source");
  await assert.rejects(applyChangeBundle(manifestPath, source), { code: "SECURITY_BLOCK" });
  await assert.rejects(readFile(path.join(source, "skills", "scott", "bundle", "skill.json")));

  const metadataBundle = signedBundle({
    schemaVersion: 1,
    manifest: fixtureManifest(),
    files: { "SKILL.md": Buffer.from("# Safe\n").toString("base64") },
    metadata: { note: token }
  });
  const metadataPath = path.join(root, "metadata-secret.json");
  await writeFile(metadataPath, stableStringify(metadataBundle));
  await assert.rejects(applyChangeBundle(metadataPath, source), { code: "SECURITY_BLOCK" });
  await assert.rejects(readFile(path.join(source, "skills", "scott", "bundle", "skill.json")));
});

test("Cowork publish workflow applies on an isolated Git branch and invokes the PR publisher", async () => {
  const fixture = await branchFixture();
  let observed;
  const result = await applyChangeBundleToBranch(fixture.bundlePath, fixture.source, {
    publishPullRequest: async (request) => {
      observed = request;
      assert.equal(git(request.stagedRoot, "branch", "--show-current"), request.branch);
      assert.equal(await readFile(path.join(request.stagedRoot, "skills", "scott", "bundle", "SKILL.md"), "utf8"), "# Branch bundle\n");
      return { url: "https://example.test/pull/1" };
    }
  });
  assert.match(result.branch, /^skillmesh\/cowork-scott-bundle-[a-f0-9]{12}$/);
  assert.equal(observed.retryKey, result.digest);
  assert.deepEqual(result.pullRequest, { url: "https://example.test/pull/1" });
  assert.equal(git(fixture.source, "branch", "--show-current"), "main");
  await assert.rejects(readFile(path.join(fixture.source, "skills", "scott", "bundle", "SKILL.md")));
});

test("publisher failure leaves the source branch untouched and the same bundle can be retried", async () => {
  const fixture = await branchFixture();
  let attempts = 0;
  const publisher = async ({ branch, retryKey }) => {
    attempts += 1;
    assert.match(branch, new RegExp(retryKey.slice(7, 19) + "$"));
    if (attempts === 1) throw new Error("injected publisher failure");
    return { url: "https://example.test/pull/retry" };
  };
  await assert.rejects(applyChangeBundleToBranch(fixture.bundlePath, fixture.source, { publishPullRequest: publisher }), /injected publisher failure/);
  assert.equal(git(fixture.source, "branch", "--show-current"), "main");
  assert.equal(git(fixture.source, "status", "--porcelain"), "");
  const retried = await applyChangeBundleToBranch(fixture.bundlePath, fixture.source, { publishPullRequest: publisher });
  assert.equal(attempts, 2);
  assert.equal(retried.pullRequest.url, "https://example.test/pull/retry");
  assert.equal(git(fixture.source, "branch", "--show-current"), "main");
  assert.equal(git(fixture.source, "status", "--porcelain"), "");
});

test("real source publisher safely retries a delayed post-push PR failure", async () => {
  const fixture = await branchFixture();
  const remote = path.join(path.dirname(fixture.source), "remote.git");
  git(path.dirname(fixture.source), "init", "--bare", "-q", remote);
  git(fixture.source, "remote", "add", "origin", remote);
  git(fixture.source, "push", "-q", "-u", "origin", "main");
  const firstPublisher = async (request) => publishSourcePullRequest(request, async (args) => {
    if (args[1] === "view") throw new Error("no pull request");
    throw new Error("injected PR creation failure");
  });
  await assert.rejects(applyChangeBundleToBranch(fixture.bundlePath, fixture.source, { publishPullRequest: firstPublisher }), /injected PR creation failure/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const secondPublisher = async (request) => publishSourcePullRequest(request, async (args) => {
    if (args[1] === "view") throw new Error("still no pull request");
    return "https://example.test/pull/retried";
  });
  const retried = await applyChangeBundleToBranch(fixture.bundlePath, fixture.source, { publishPullRequest: secondPublisher });
  assert.equal(retried.pullRequest.url, "https://example.test/pull/retried");
});

function fixtureManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "scott/bundle",
    version: "1.0.0",
    displayName: "Bundle",
    description: "Bundle fixture",
    files: ["SKILL.md"],
    targets: { required: [{ harness: "codex", os: "darwin", profile: "default", scope: "global" }] },
    ...overrides
  };
}

function signedBundle(payload) {
  return { ...payload, digest: `sha256:${createHash("sha256").update(stableStringify(payload)).digest("hex")}` };
}

async function branchFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-bundle-branch-"));
  const source = path.join(root, "source");
  const draft = path.join(root, "draft");
  await mkdir(source);
  await mkdir(draft);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "SkillMesh Test");
  git(source, "config", "user.email", "skillmesh@example.test");
  await writeFile(path.join(source, "README.md"), "source\n");
  git(source, "add", "README.md");
  git(source, "commit", "-q", "-m", "Initial");
  await writeFile(path.join(draft, "SKILL.md"), "# Branch bundle\n");
  await writeFile(path.join(draft, "skill.json"), stableStringify(fixtureManifest()));
  const bundlePath = path.join(root, "change.skillmesh.json");
  await createChangeBundle(draft, bundlePath);
  return { bundlePath, source };
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
