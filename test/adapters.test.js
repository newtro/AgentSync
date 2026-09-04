import assert from "node:assert/strict";
import test from "node:test";

import { adapterPlan, createEnrollments } from "../src/lib/adapters.js";

test("one machine enrolls Codex and both Claude profiles independently", () => {
  const enrollments = createEnrollments({ home: "/home/scott", machine: "mac", nodePlatform: "darwin", projectRoots: ["/repo"] });
  assert.equal(enrollments.length, 8);
  assert.equal(new Set(enrollments.map((item) => item.id)).size, enrollments.length);
  assert.ok(enrollments.some((item) => item.harness === "claude-desktop" && item.profile === "personal"));
  assert.ok(enrollments.some((item) => item.harness === "claude-desktop" && item.profile === "organization"));
});

test("personal Desktop remains assisted and organization remains provider-observed", () => {
  const enrollments = createEnrollments({ home: "/home/scott", machine: "mac", nodePlatform: "darwin" });
  const personal = enrollments.find((item) => item.harness === "claude-desktop" && item.profile === "personal");
  const organization = enrollments.find((item) => item.harness === "claude-desktop" && item.profile === "organization");
  assert.equal(adapterPlan(personal, "git@github.com:x/y.git").stateUntilVerified, "assisted-action-required");
  assert.equal(adapterPlan(organization, "git@github.com:x/y.git").stateUntilVerified, "unknown");
});
