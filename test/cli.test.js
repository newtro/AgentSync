import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";

function capture() {
  const lines = [];
  return {
    lines,
    io: {
      log: (value) => lines.push(String(value)),
      error: (value) => lines.push(String(value))
    }
  };
}

test("doctor produces machine-readable health", async () => {
  const output = capture();
  assert.equal(await main(["doctor", "--json"], output.io), 0);
  const result = JSON.parse(output.lines[0]);
  assert.equal(result.diagnosticComplete, true);
  assert.equal(typeof result.node, "string");
});

test("unknown commands are redacted", async () => {
  const output = capture();
  const fake = `github_pat_${"A".repeat(30)}`;
  assert.equal(await main([fake], output.io), 2);
  assert.doesNotMatch(output.lines[0], new RegExp(fake));
  assert.match(output.lines[0], /\[REDACTED\]/);
});

test("unknown command fails without throwing", async () => {
  const output = capture();
  assert.equal(await main(["wat"], output.io), 2);
  assert.match(output.lines[0], /Unknown command/);
});

test("late secret failures open a redacted remediation incident", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillmesh-cli-secret-"));
  const token = `ghp_${"a".repeat(24)}`;
  await writeFile(path.join(root, "leak.txt"), token);
  const output = capture();
  assert.equal(await main(["security-scan", "--root", root, "--revision", "committed-source", "--json"], output.io), 1);
  assert.doesNotMatch(output.lines[0], new RegExp(token));
  assert.match(output.lines[0], /Security incident opened/);
  assert.match(output.lines[0], /Git history remediation is required/);
});

test("trusted source workflow gates updater templates and loads full history", async () => {
  const contract = await readFile(new URL("../.github/workflows/source-contract.yml", import.meta.url), "utf8");
  const validation = await readFile(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8");
  assert.match(contract, /promote --source candidate /);
  const publishJob = validation.slice(validation.indexOf("publish-distribution:"));
  assert.match(publishJob, /fetch-depth: 0/);
  assert.match(publishJob, /promote --source \. /);
});
