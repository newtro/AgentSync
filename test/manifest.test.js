import assert from "node:assert/strict";
import test from "node:test";

import { validateManifest } from "../src/lib/manifest.js";

const valid = {
  schemaVersion: 1,
  id: "scott/example",
  version: "1.2.3",
  displayName: "Example",
  description: "An example skill",
  files: ["SKILL.md"],
  targets: { required: [{ harness: "codex", os: "darwin", scope: "global" }] }
};

test("normalizes a canonical manifest", () => {
  const manifest = validateManifest(valid);
  assert.equal(manifest.targets.required[0].profile, "default");
  assert.deepEqual(manifest.runtimes, []);
  assert.deepEqual(manifest.files[0], { source: "SKILL.md", destination: "SKILL.md", kind: "text" });
});

test("accepts valid prereleases and rejects malformed semantic versions", () => {
  for (const version of ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-0", "1.0.0-x-y.z"]) assert.equal(validateManifest({ ...valid, version }).version, version);
  for (const version of ["1.0.0-...", "1.0.0-alpha..beta", "1.0.0-01"]) assert.throws(() => validateManifest({ ...valid, version }), { code: "VERSION_INVALID" });
});

test("rejects identifiers and versions that cannot form portable artifact paths", () => {
  assert.throws(() => validateManifest({ ...valid, id: `owner/${"a".repeat(60)}` }), { code: "ID_INVALID" });
  assert.throws(() => validateManifest({ ...valid, version: `1.0.0-${"a".repeat(40)}` }), { code: "VERSION_INVALID" });
});

test("rejects path traversal and Windows reserved names", () => {
  assert.throws(() => validateManifest({ ...valid, files: ["SKILL.md", "../oops"] }), { code: "PATH_TRAVERSAL" });
  assert.throws(() => validateManifest({ ...valid, files: ["SKILL.md", "con.txt"] }), { code: "PATH_WINDOWS_INVALID" });
  assert.throws(() => validateManifest({ ...valid, files: ["SKILL.md", "bad:name.txt"] }), { code: "PATH_WINDOWS_INVALID" });
  assert.throws(() => validateManifest({ ...valid, files: ["SKILL.md", "A.txt", "a.txt"] }), { code: "PATH_CASE_COLLISION" });
});

test("validates overlay match values and supports destination replacement", () => {
  assert.throws(() => validateManifest({ ...valid, overlays: [{ match: { harness: "typo" }, files: [] }] }), { code: "OVERLAY_MATCH_INVALID" });
  const manifest = validateManifest({
    ...valid,
    overlays: [{ match: { os: "darwin" }, files: [{ source: "overlays/mac.md", destination: "SKILL.md", kind: "text" }] }]
  });
  assert.equal(manifest.overlays[0].files[0].destination, "SKILL.md");
});

test("removed lifecycle defaults to a seven-day grace and rejects unknown states", () => {
  assert.equal(validateManifest({ ...valid, lifecycle: { state: "removed" } }).lifecycle.graceDays, 7);
  assert.throws(() => validateManifest({ ...valid, lifecycle: { state: "gone" } }), { code: "LIFECYCLE_INVALID" });
  assert.throws(() => validateManifest({ ...valid, lifecycle: { state: "removed", graceDays: 0 } }), { code: "EMERGENCY_APPROVAL" });
  const approved = validateManifest({ ...valid, lifecycle: { state: "removed", graceDays: 0, emergencyOverride: { approvedBy: "owner", reason: "credential exposure", approvedAt: "2026-01-01T00:00:00Z" } } });
  assert.equal(approved.lifecycle.emergencyOverride.approvedBy, "owner");
  for (const removeAfter of ["0", "2026", "2026-09-04"]) assert.throws(() => validateManifest({ ...valid, lifecycle: { state: "removed", removeAfter, emergencyOverride: { approvedBy: "owner", reason: "test", approvedAt: "2026-01-01T00:00:00Z" } } }), { code: "LIFECYCLE_INVALID" });
  assert.throws(() => validateManifest({ ...valid, lifecycle: { state: "removed", graceDays: 0, emergencyOverride: { approvedBy: "owner", reason: "test", approvedAt: "2026-01-01" } } }), { code: "EMERGENCY_APPROVAL" });
});

test("rejects target deny conflicts", () => {
  const target = { harness: "codex", os: "darwin", scope: "global" };
  assert.throws(() => validateManifest({ ...valid, targets: { required: [target], denied: [target] } }), { code: "TARGET_CONFLICT" });
});

test("rejects target combinations no endpoint adapter can consume", () => {
  assert.throws(() => validateManifest({ ...valid, targets: { required: [{ harness: "claude-desktop", os: "darwin", profile: "personal", scope: "project" }] } }), { code: "TARGET_SCOPE" });
  assert.throws(() => validateManifest({ ...valid, targets: { required: [{ harness: "claude-code", os: "darwin", profile: "default", scope: "global" }] } }), { code: "TARGET_PROFILE" });
});

test("requires explicit script mode and a declared runtime for executables", () => {
  assert.throws(() => validateManifest({ ...valid, files: ["SKILL.md", "run.sh"] }), { code: "EXECUTABLE_AMBIGUOUS" });
  assert.throws(() => validateManifest({ ...valid, files: ["SKILL.md", { source: "run.sh", executable: true }] }), { code: "RUNTIME_UNDECLARED" });
  const manifest = validateManifest({ ...valid, files: ["SKILL.md", { source: "run.sh", executable: true }], runtimes: ["sh"] });
  assert.equal(manifest.files.find((file) => file.source === "run.sh").executable, true);
});

test("rejects unknown manifest, file, and target keys", () => {
  assert.throws(() => validateManifest({ ...valid, typo: true }), { code: "MANIFEST_UNKNOWN_KEY" });
  assert.throws(() => validateManifest({ ...valid, files: ["SKILL.md", { source: "asset.bin", typo: true }] }), { code: "FILE_SPEC_INVALID" });
  assert.throws(() => validateManifest({ ...valid, targets: { required: [{ harness: "codex", os: "darwin", scope: "global", typo: true }] } }), { code: "TARGET_INVALID" });
});

test("rejects unknown activation modes and non-string lifecycle messages", () => {
  for (const activation of ["live", "reload", "next-launch"]) assert.equal(validateManifest({ ...valid, activation }).activation, activation);
  assert.throws(() => validateManifest({ ...valid, activation: "telepathy" }), { code: "ACTIVATION_INVALID" });
  assert.throws(() => validateManifest({ ...valid, lifecycle: { state: "deprecated", message: 42 } }), { code: "LIFECYCLE_INVALID" });
});
