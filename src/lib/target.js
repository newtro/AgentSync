import { invariant } from "./errors.js";

export const HARNESSES = ["codex", "claude-code", "claude-desktop"];
export const OPERATING_SYSTEMS = ["darwin", "windows"];
export const SCOPES = ["global", "project"];
export const PROFILES = ["default", "personal", "organization"];

export function normalizeTarget(target) {
  invariant(target && typeof target === "object", "TARGET_INVALID", "Target must be an object");
  const unknown = Object.keys(target).filter((key) => !["harness", "os", "profile", "scope"].includes(key));
  invariant(unknown.length === 0, "TARGET_INVALID", `Unknown target keys: ${unknown.join(", ")}`);
  const normalized = {
    harness: target.harness,
    os: target.os,
    profile: target.profile ?? (target.harness === "codex" ? "default" : "personal"),
    scope: target.scope
  };
  invariant(HARNESSES.includes(normalized.harness), "TARGET_HARNESS", `Unsupported harness: ${normalized.harness}`);
  invariant(OPERATING_SYSTEMS.includes(normalized.os), "TARGET_OS", `Unsupported operating system: ${normalized.os}`);
  invariant(PROFILES.includes(normalized.profile), "TARGET_PROFILE", `Unsupported profile: ${normalized.profile}`);
  invariant(SCOPES.includes(normalized.scope), "TARGET_SCOPE", `Unsupported scope: ${normalized.scope}`);
  invariant(!(normalized.harness === "codex" && normalized.profile !== "default"), "TARGET_PROFILE", "Codex targets use the default profile");
  invariant(!(normalized.harness !== "codex" && normalized.profile === "default"), "TARGET_PROFILE", "Claude targets require personal or organization profile");
  invariant(!(normalized.harness === "claude-desktop" && normalized.scope !== "global"), "TARGET_SCOPE", "Claude Desktop supports only global skill scope");
  return normalized;
}
export function targetKey(target) {
  const value = normalizeTarget(target);
  return `${value.harness}--${value.os}--${value.profile}--${value.scope}`;
}

export function targetMatches(match, target) {
  return Object.entries(match).every(([key, value]) => target[key] === value);
}
