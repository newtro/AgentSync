import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileProjection, providerSafeName, writeProjection } from "../src/lib/compiler.js";

const target = { harness: "codex", os: "darwin", profile: "default", scope: "global" };
const canonical = {
  manifest: {
    schemaVersion: 1,
    id: "scott/example",
    version: "1.0.0",
    displayName: "Example",
    description: "Example description",
    files: ["SKILL.md"],
    targets: { required: [target] }
  },
  files: new Map([["SKILL.md", Buffer.from("# Example\r\n")]])
};

test("compilation is deterministic and normalizes line endings", () => {
  const first = compileProjection(canonical, target, "abc123");
  const second = compileProjection(canonical, target, "abc123");
  assert.equal(first.digest, second.digest);
  assert.match(first.files.get("SKILL.md").toString(), new RegExp(`^---\\nname: ${providerSafeName("scott/example", target)}\\ndescription: "Example description"\\n---`));
});

test("Claude projection uses plugin packaging", () => {
  const claudeTarget = { harness: "claude-code", os: "windows", profile: "personal", scope: "project" };
  const source = {
    ...canonical,
    manifest: { ...canonical.manifest, targets: { required: [claudeTarget] } }
  };
  const projection = compileProjection(source, claudeTarget, "working-tree", 3);
  assert.ok(projection.files.has(".claude-plugin/plugin.json"));
  const skillFile = [...projection.files.keys()].find((key) => key.endsWith("/SKILL.md"));
  assert.ok(skillFile);
  const plugin = JSON.parse(projection.files.get(".claude-plugin/plugin.json"));
  assert.match(plugin.name, /^scott-example-[a-f0-9]{8}$/);
  assert.match(projection.files.get(skillFile).toString(), new RegExp(`^---\\nname: ${plugin.name}\\n`));
  assert.equal(plugin.version, "3.0.0");
});

test("binary assets are byte-preserving and overlays replace destinations", () => {
  const source = {
    manifest: {
      ...canonical.manifest,
      files: ["SKILL.md", { source: "asset.bin", kind: "binary" }],
      overlays: [{ match: { os: "darwin", profile: "default" }, files: [{ source: "mac.md", destination: "SKILL.md" }] }]
    },
    files: new Map([
      ["SKILL.md", Buffer.from("base")],
      ["mac.md", Buffer.from("mac")],
      ["asset.bin", Buffer.from([0x00, 0xff, 0x01])]
    ])
  };
  const projection = compileProjection(source, { harness: "codex", os: "darwin", scope: "global" });
  assert.deepEqual(projection.files.get("asset.bin"), Buffer.from([0x00, 0xff, 0x01]));
  assert.match(projection.files.get("SKILL.md").toString(), /\nmac\n$/);
  assert.equal(projection.metadata.target.profile, "default");
});

test("artifact digest authenticates provenance metadata", () => {
  const first = compileProjection(canonical, target, "commit-a");
  const second = compileProjection(canonical, target, "commit-b");
  assert.notEqual(first.digest, second.digest);
  assert.equal(first.metadata.payloadDigest, second.metadata.payloadDigest);
});

test("only allowlisted structural smoke tests run for every target", () => {
  const source = { ...canonical, manifest: { ...canonical.manifest, smokeTests: [{ type: "file-contains", path: "SKILL.md", contains: "Missing" }] } };
  assert.throws(() => compileProjection(source, target), { code: "SMOKE_TEST_FAILED" });
  assert.throws(() => compileProjection({ ...canonical, manifest: { ...canonical.manifest, smokeTests: [{ type: "execute", path: "SKILL.md" }] } }, target), { code: "SMOKE_TEST_TYPE" });
});

test("removed releases compile to a disabled tombstone under a higher provider revision", () => {
  const claudeTarget = { harness: "claude-desktop", os: "darwin", profile: "personal", scope: "global" };
  const removed = {
    ...canonical,
    manifest: { ...canonical.manifest, lifecycle: { state: "removed" }, targets: { required: [claudeTarget] } }
  };
  const projection = compileProjection(removed, claudeTarget, "commit", 7);
  const plugin = JSON.parse(projection.files.get(".claude-plugin/plugin.json"));
  const skillPath = [...projection.files.keys()].find((key) => key.endsWith("/SKILL.md"));
  assert.equal(plugin.version, "7.0.0");
  assert.match(projection.files.get(skillPath).toString(), /disabled and must not perform/);
});

test("declared executable modes and runtimes are authenticated and materialized", { skip: process.platform === "win32" && "POSIX executable bits are not material on Windows" }, async () => {
  const source = {
    manifest: { ...canonical.manifest, files: ["SKILL.md", { source: "run.sh", executable: true }], runtimes: ["sh"] },
    files: new Map([...canonical.files, ["run.sh", Buffer.from("#!/bin/sh\nexit 0\n")]])
  };
  const projection = compileProjection(source, target);
  assert.deepEqual(projection.metadata.requiredRuntimes, ["sh"]);
  assert.deepEqual(projection.metadata.executableFiles, ["run.sh"]);
  const output = await mkdtemp(path.join(os.tmpdir(), "skillmesh-executable-"));
  await writeProjection(projection, output);
  assert.notEqual((await stat(path.join(output, "run.sh"))).mode & 0o111, 0);
});
