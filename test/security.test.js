import assert from "node:assert/strict";
import test from "node:test";

import { assertSecure, redact, scanText } from "../src/lib/security.js";
import { scanRepository } from "../src/lib/repo-security.js";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("secret fixtures block the whole revision without exposing the value", () => {
  const fake = `github_pat_${"A".repeat(30)}`;
  assert.equal(scanText(fake, "fixture.txt")[0].value, "[REDACTED]");
  assert.throws(
    () => assertSecure([{ path: "fixture.txt", content: fake }], "merged123"),
    (error) => error.code === "SECURITY_BLOCK" && error.details.requiresHistoryRemediation && !JSON.stringify(error).includes(fake)
  );
});

test("binary assets cannot hide recognized credentials behind NUL bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-binary-secret-"));
  const fake = `github_pat_${"A".repeat(30)}`;
  await writeFile(path.join(root, "asset.bin"), Buffer.concat([Buffer.from([0]), Buffer.from(fake)]));
  await assert.rejects(scanRepository(root), { code: "SECURITY_BLOCK" });
});

test("UTF-16LE Windows scripts cannot hide recognized credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-utf16-secret-"));
  const fake = `github_pat_${"B".repeat(30)}`;
  await writeFile(path.join(root, "script.ps1"), Buffer.from(fake, "utf16le"));
  await assert.rejects(scanRepository(root), { code: "SECURITY_BLOCK" });
});

test("repository scanning does not skip generated-looking directories inside skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-nested-dist-secret-"));
  await mkdir(path.join(root, "skills", "scott", "x", "dist"), { recursive: true });
  await writeFile(path.join(root, "skills", "scott", "x", "dist", "leak.txt"), `ghp_${"a".repeat(24)}`);
  await assert.rejects(scanRepository(root), { code: "SECURITY_BLOCK" });
});

test("repository scanning rejects symlinks under canonical skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-repo-symlink-"));
  await mkdir(path.join(root, "skills", "scott", "x"), { recursive: true });
  await symlink("../outside", path.join(root, "skills", "scott", "x", "link"));
  await assert.rejects(scanRepository(root), { code: "SYMLINK_FORBIDDEN" });
});

test("redacts secrets and credential query values", () => {
  const fake = `sk-ant-${"x".repeat(30)}`;
  assert.equal(redact(`failed ${fake} https://x.test?a=1&token=hello`), "failed [REDACTED] https://x.test?a=1&token=[REDACTED]");
});
