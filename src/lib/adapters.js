import path from "node:path";

import { invariant } from "./errors.js";

export function platformName(nodePlatform = process.platform) {
  if (nodePlatform === "darwin") return "darwin";
  if (nodePlatform === "win32") return "windows";
  return nodePlatform;
}

export function createEnrollments({ home, machine, nodePlatform = process.platform, projectRoots = [] }) {
  const os = platformName(nodePlatform);
  invariant(["darwin", "windows"].includes(os), "PLATFORM_UNSUPPORTED", `Unsupported endpoint platform: ${os}`);
  const enrollments = [];
  enrollments.push(enrollment(machine, "codex", "default", "global", os, path.join(home, ".agents", "skills"), "direct"));
  for (const projectRoot of projectRoots) {
    enrollments.push(enrollment(machine, "codex", "default", "project", os, path.join(projectRoot, ".agents", "skills"), "direct", projectRoot));
  }
  for (const profile of ["personal", "organization"]) {
    enrollments.push(enrollment(machine, "claude-code", profile, "global", os, null, "marketplace"));
    for (const projectRoot of projectRoots) enrollments.push(enrollment(machine, "claude-code", profile, "project", os, null, "marketplace", projectRoot));
    enrollments.push(enrollment(machine, "claude-desktop", profile, "global", os, null, profile === "personal" ? "assisted" : "organization-marketplace"));
  }
  return enrollments;
}

export function adapterPlan(enrollment, distributionRepo) {
  const target = {
    harness: enrollment.harness,
    os: enrollment.os,
    profile: enrollment.profile,
    scope: enrollment.scope
  };
  if (enrollment.mode === "direct") {
    return { target, mode: "direct", root: enrollment.installRoot, activation: "next-session" };
  }
  if (enrollment.mode === "marketplace") {
    const scope = enrollment.scope === "project" ? "project" : "user";
    return {
      target,
      mode: "provider-command",
      commands: [
        ["claude", "plugin", "marketplace", "add", distributionRepo, "--scope", scope],
        ["claude", "plugin", "install", "<generated-plugin>@skillmesh-stable", "--scope", scope]
      ],
      activation: "reload-plugins-or-next-launch",
      stateUntilVerified: "unknown"
    };
  }
  if (enrollment.mode === "organization-marketplace") {
    return {
      target,
      mode: "provider-consent",
      action: "Connect the private distribution repository in Organization settings > Plugins > GitHub and enable automatic updates",
      stateUntilVerified: "unknown"
    };
  }
  return {
    target,
    mode: "assisted",
    action: "In Claude Desktop, add or refresh the SkillMesh personal marketplace from the configured distribution repository",
    stateUntilVerified: "assisted-action-required"
  };
}

export function endpointId(enrollment) {
  return [enrollment.machine, enrollment.harness, enrollment.profile, enrollment.scope, enrollment.projectRoot ?? "-"].map(encodeURIComponent).join("|");
}

function enrollment(machine, harness, profile, scope, os, installRoot, mode, projectRoot) {
  const value = { machine, harness, profile, scope, os, mode, installRoot, accountBinding: profile === "default" ? "not-applicable" : "unbound" };
  if (projectRoot) value.projectRoot = projectRoot;
  value.id = endpointId(value);
  return value;
}
