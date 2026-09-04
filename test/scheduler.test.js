import assert from "node:assert/strict";
import test from "node:test";

import { schedulePlan, windowsQuote } from "../src/lib/scheduler.js";

test("macOS schedule is every fifteen minutes and safely escapes paths", () => {
  const plan = schedulePlan({ nodePlatform: "darwin", executable: "/A&B/tool", home: "/Users/test" });
  assert.match(plan.content, /<integer>900<\/integer>/);
  assert.match(plan.content, /\/A&amp;B\/tool/);
});

test("Windows schedule invokes cmd launchers through cmd.exe with explicit safe switches", () => {
  const plan = schedulePlan({ nodePlatform: "win32", executable: "C:\\Program Files\\SkillMesh\\skillmesh.cmd", commandArgs: ["sync", "--state", "C:\\User State"], home: "C:\\Users\\test" });
  assert.match(plan.content, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(plan.content, /<Command>cmd\.exe<\/Command>/);
  assert.match(plan.content, /\/d \/s \/c/);
  assert.match(plan.content, /&quot;C:\\Program Files\\SkillMesh\\skillmesh\.cmd&quot;/);
  assert.match(plan.content, /&quot;C:\\User State&quot;/);
  assert.match(plan.content, /<RandomDelay>PT2M<\/RandomDelay>/);
  assert.deepEqual(plan.command.slice(0, 2), ["schtasks.exe", "/Create"]);
});

test("Windows quoting preserves spaces and trailing backslashes", () => {
  assert.equal(windowsQuote("plain"), "plain");
  assert.equal(windowsQuote("C:\\A B\\"), '"C:\\A B\\\\"');
});
