import assert from "node:assert/strict";
import test from "node:test";

import { probeCapabilities } from "../src/lib/probe.js";

test("capability probe reports truthfully distinct available, assisted, and unknown states", async () => {
  const result = await probeCapabilities({
    platform: "darwin",
    home: "/test-home",
    exec: async (command) => ({ available: command === "codex" || command === "open", version: command === "codex" ? "1.2.3" : undefined })
  });
  assert.equal(result.ready, false);
  assert.equal(result.targets.find((target) => target.harness === "codex").state, "available");
  assert.equal(result.targets.find((target) => target.harness === "claude-code").state, "unsupported");
  assert.equal(result.targets.find((target) => target.profile === "personal" && target.harness === "claude-desktop").state, "assisted-action-required");
  assert.equal(result.targets.find((target) => target.profile === "organization").state, "unknown");
});

test("an absent Windows MSIX package remains unknown pending a live provider probe", async () => {
  const result = await probeCapabilities({
    platform: "win32",
    home: "C:\\Users\\test",
    exec: async () => ({ available: false, version: null })
  });
  const desktop = result.targets.filter((target) => target.harness === "claude-desktop");
  assert.ok(desktop.every((target) => target.state === "unknown"));
  assert.ok(desktop.every((target) => target.reason.includes("Get-AppxPackage")));
});
