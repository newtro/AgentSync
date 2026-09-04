import path from "node:path";

import { invariant } from "./errors.js";
import { HARNESSES, normalizeTarget, OPERATING_SYSTEMS, PROFILES, SCOPES, targetKey } from "./target.js";
import { isRfc3339Timestamp } from "./time.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9-]*$/;
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
export const MAX_SKILL_ID_LENGTH = 60;
export const MAX_VERSION_LENGTH = 40;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function validateManifest(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "MANIFEST_INVALID", "Manifest must be an object");
  const allowedTopLevel = new Set(["schemaVersion", "id", "version", "displayName", "description", "files", "overlays", "runtimes", "targets", "activation", "lifecycle", "smokeTests"]);
  const unknownTopLevel = Object.keys(input).filter((key) => !allowedTopLevel.has(key));
  invariant(unknownTopLevel.length === 0, "MANIFEST_UNKNOWN_KEY", `Unknown manifest keys: ${unknownTopLevel.join(", ")}`);
  invariant(input.schemaVersion === 1, "SCHEMA_UNSUPPORTED", `Unsupported schema version: ${input.schemaVersion}`);
  invariant(ID_PATTERN.test(input.id ?? "") && input.id.length <= MAX_SKILL_ID_LENGTH, "ID_INVALID", `Skill id must be a lowercase namespaced id no longer than ${MAX_SKILL_ID_LENGTH} characters`);
  invariant(VERSION_PATTERN.test(input.version ?? "") && input.version.length <= MAX_VERSION_LENGTH, "VERSION_INVALID", `Skill version must be semantic version syntax no longer than ${MAX_VERSION_LENGTH} characters`);
  invariant(typeof input.displayName === "string" && input.displayName.trim(), "DISPLAY_NAME_INVALID", "Display name is required");
  invariant(typeof input.description === "string" && input.description.trim(), "DESCRIPTION_INVALID", "Description is required");
  invariant(Array.isArray(input.files) && input.files.length > 0, "FILES_INVALID", "At least one shared file is required");

  const files = uniqueFileSpecs(input.files);
  invariant(files.some((file) => file.destination === "SKILL.md"), "SKILL_MISSING", "Every canonical skill must produce SKILL.md");

  invariant(input.targets && typeof input.targets === "object" && !Array.isArray(input.targets), "TARGETS_INVALID", "targets must be an object");
  const unknownTargetKeys = Object.keys(input.targets).filter((key) => !["required", "denied"].includes(key));
  invariant(unknownTargetKeys.length === 0, "TARGETS_INVALID", `Unknown targets keys: ${unknownTargetKeys.join(", ")}`);
  const required = uniqueTargets(input.targets.required ?? []);
  const denied = uniqueTargets(input.targets?.denied ?? []);
  invariant(required.length > 0, "TARGETS_EMPTY", "At least one required target is required");
  const deniedKeys = new Set(denied.map(targetKey));
  invariant(!required.some((target) => deniedKeys.has(targetKey(target))), "TARGET_CONFLICT", "A target cannot be both required and denied");
  for (const target of required) validateRelativePath(path.posix.join("artifacts", input.id.replace("/", "__"), input.version, targetKey(target)));

  const overlays = (input.overlays ?? []).map((overlay, index) => {
    invariant(overlay && typeof overlay === "object", "OVERLAY_INVALID", `Overlay ${index} must be an object`);
    const unknownOverlayKeys = Object.keys(overlay).filter((key) => !["match", "files"].includes(key));
    invariant(unknownOverlayKeys.length === 0, "OVERLAY_INVALID", `Overlay ${index} has unknown keys: ${unknownOverlayKeys.join(", ")}`);
    invariant(overlay.match && typeof overlay.match === "object", "OVERLAY_MATCH_INVALID", `Overlay ${index} needs match criteria`);
    const unknown = Object.keys(overlay.match).filter((key) => !["harness", "os", "profile", "scope"].includes(key));
    invariant(unknown.length === 0, "OVERLAY_MATCH_INVALID", `Overlay ${index} has unknown match keys: ${unknown.join(", ")}`);
    for (const [key, value] of Object.entries(overlay.match)) {
      const allowed = { harness: HARNESSES, os: OPERATING_SYSTEMS, profile: PROFILES, scope: SCOPES }[key];
      invariant(allowed.includes(value), "OVERLAY_MATCH_INVALID", `Overlay ${index} has unsupported ${key}: ${value}`);
    }
    invariant(Array.isArray(overlay.files), "OVERLAY_FILES_INVALID", `Overlay ${index} files must be an array`);
    return { match: { ...overlay.match }, files: uniqueFileSpecs(overlay.files) };
  });

  validateCaseSafety([...files, ...overlays.flatMap((overlay) => overlay.files)]);

  const runtimes = [...new Set(input.runtimes ?? [])].sort();
  for (const runtime of runtimes) {
    invariant(["node", "python", "powershell", "sh"].includes(runtime), "RUNTIME_UNDECLARED", `Unsupported runtime declaration: ${runtime}`);
  }
  for (const file of [...files, ...overlays.flatMap((overlay) => overlay.files)]) {
    const runtime = runtimeForPath(file.destination);
    if (!runtime) continue;
    invariant(typeof file.executable === "boolean", "EXECUTABLE_AMBIGUOUS", `Script file must explicitly declare executable true or false: ${file.destination}`);
    if (file.executable) invariant(runtimes.includes(runtime), "RUNTIME_UNDECLARED", `Executable ${file.destination} requires declared runtime ${runtime}`);
  }

  const activation = input.activation ?? "next-launch";
  invariant(["live", "reload", "next-launch"].includes(activation), "ACTIVATION_INVALID", `Unsupported activation mode: ${activation}`);

  return {
    schemaVersion: 1,
    id: input.id,
    version: input.version,
    displayName: input.displayName.trim(),
    description: input.description.trim(),
    files,
    overlays,
    runtimes,
    targets: { required, denied },
    activation,
    lifecycle: validateLifecycle(input.lifecycle ?? { state: "enabled" }),
    smokeTests: validateSmokeTests(input.smokeTests ?? [])
  };
}

export function validateRelativePath(value) {
  invariant(typeof value === "string" && value.length > 0, "PATH_INVALID", "File paths must be non-empty strings");
  invariant(!value.includes("\\"), "PATH_SEPARATOR", `Use forward slashes in canonical paths: ${value}`);
  invariant(!path.posix.isAbsolute(value), "PATH_ABSOLUTE", `Absolute path is forbidden: ${value}`);
  const normalized = path.posix.normalize(value);
  invariant(normalized === value && !normalized.startsWith("../") && normalized !== "..", "PATH_TRAVERSAL", `Unsafe path: ${value}`);
  invariant(value.length <= 180, "PATH_TOO_LONG", `Canonical path exceeds 180 characters: ${value}`);
  for (const segment of value.split("/")) {
    invariant(segment !== "." && segment !== ".." && segment.length > 0, "PATH_INVALID", `Unsafe path segment in: ${value}`);
    invariant(!/[<>:"|?*\x00-\x1f]/.test(segment), "PATH_WINDOWS_INVALID", `Path contains characters invalid on Windows: ${value}`);
    invariant(!WINDOWS_RESERVED.test(segment) && !/[. ]$/.test(segment), "PATH_WINDOWS_INVALID", `Path is not portable to Windows: ${value}`);
  }
  return value;
}

function normalizeFileSpec(value) {
  if (typeof value === "string") {
    const source = validateRelativePath(value);
    return { source, destination: source, kind: inferKind(source) };
  }
  invariant(value && typeof value === "object", "FILE_SPEC_INVALID", "File entries must be paths or mapping objects");
  const unknown = Object.keys(value).filter((key) => !["source", "destination", "kind", "executable"].includes(key));
  invariant(unknown.length === 0, "FILE_SPEC_INVALID", `Unknown file keys: ${unknown.join(", ")}`);
  const source = validateRelativePath(value.source);
  const destination = validateRelativePath(value.destination ?? value.source);
  const kind = value.kind ?? inferKind(source);
  invariant(["text", "binary"].includes(kind), "FILE_KIND_INVALID", `Unsupported file kind: ${kind}`);
  invariant(value.executable === undefined || typeof value.executable === "boolean", "EXECUTABLE_INVALID", `Executable flag must be boolean: ${destination}`);
  return { source, destination, kind, ...(value.executable === undefined ? {} : { executable: value.executable }) };
}

function uniqueFileSpecs(values) {
  const specs = values.map(normalizeFileSpec);
  const byDestination = new Map();
  for (const spec of specs) byDestination.set(spec.destination, spec);
  return [...byDestination.values()].sort((a, b) => a.destination.localeCompare(b.destination));
}

function inferKind(filePath) {
  return /\.(?:md|txt|json|ya?ml|toml|xml|html?|css|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|ps1|bat|cmd)$/i.test(filePath) ? "text" : "binary";
}

function runtimeForPath(filePath) {
  const extension = path.posix.extname(filePath).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "node";
  if (extension === ".py") return "python";
  if (extension === ".ps1") return "powershell";
  if ([".sh", ".bash", ".zsh"].includes(extension)) return "sh";
  return null;
}

function validateCaseSafety(specs) {
  for (const field of ["source", "destination"]) {
    const seen = new Map();
    for (const spec of specs) {
      const folded = spec[field].toLocaleLowerCase("en-US");
      const previous = seen.get(folded);
      invariant(!previous || previous === spec[field], "PATH_CASE_COLLISION", `Case-colliding ${field} paths: ${previous} and ${spec[field]}`);
      seen.set(folded, spec[field]);
    }
  }
}

function validateSmokeTests(values) {
  invariant(Array.isArray(values), "SMOKE_TESTS_INVALID", "Smoke tests must be an array");
  return values.map((test, index) => {
    invariant(test && typeof test === "object", "SMOKE_TEST_INVALID", `Smoke test ${index} must be an object`);
    const unknown = Object.keys(test).filter((key) => !["type", "path", "contains", "match"].includes(key));
    invariant(unknown.length === 0, "SMOKE_TEST_INVALID", `Smoke test ${index} has unknown keys: ${unknown.join(", ")}`);
    invariant(["file-exists", "file-contains"].includes(test.type), "SMOKE_TEST_TYPE", `Smoke test ${index} uses a non-allowlisted type`);
    const normalized = { type: test.type, path: validateRelativePath(test.path) };
    if (test.type === "file-contains") {
      invariant(typeof test.contains === "string" && test.contains.length > 0 && test.contains.length <= 500, "SMOKE_TEST_ASSERTION", `Smoke test ${index} needs a bounded contains assertion`);
      normalized.contains = test.contains;
    }
    if (test.match) {
      invariant(test.match && typeof test.match === "object", "SMOKE_TEST_MATCH", `Smoke test ${index} match must be an object`);
      for (const [key, value] of Object.entries(test.match)) {
        const allowed = { harness: HARNESSES, os: OPERATING_SYSTEMS, profile: PROFILES, scope: SCOPES }[key];
        invariant(allowed?.includes(value), "SMOKE_TEST_MATCH", `Smoke test ${index} has unsupported ${key}: ${value}`);
      }
      normalized.match = { ...test.match };
    }
    return normalized;
  });
}

export function validateLifecycle(value) {
  invariant(value && typeof value === "object", "LIFECYCLE_INVALID", "Lifecycle must be an object");
  const unknown = Object.keys(value).filter((key) => !["state", "removeAfter", "graceDays", "message", "emergencyOverride"].includes(key));
  invariant(unknown.length === 0, "LIFECYCLE_INVALID", `Unknown lifecycle keys: ${unknown.join(", ")}`);
  invariant(["enabled", "deprecated", "removed"].includes(value.state), "LIFECYCLE_INVALID", `Unsupported lifecycle state: ${value.state}`);
  const lifecycle = { state: value.state };
  if (value.state === "removed") {
    let emergency = false;
    if (value.removeAfter !== undefined) {
      invariant(isRfc3339Timestamp(value.removeAfter), "LIFECYCLE_INVALID", "removeAfter must be an RFC3339 timestamp");
      lifecycle.removeAfter = new Date(value.removeAfter).toISOString();
      emergency = true;
    } else {
      lifecycle.graceDays = value.graceDays ?? 7;
      invariant(Number.isSafeInteger(lifecycle.graceDays) && lifecycle.graceDays >= 0, "LIFECYCLE_INVALID", "graceDays must be a non-negative integer");
      emergency = lifecycle.graceDays === 0;
    }
    if (emergency) {
      invariant(value.emergencyOverride && typeof value.emergencyOverride === "object", "EMERGENCY_APPROVAL", "Immediate removal requires an explicit reviewed emergencyOverride");
      const unknownOverride = Object.keys(value.emergencyOverride).filter((key) => !["approvedBy", "reason", "approvedAt"].includes(key));
      invariant(unknownOverride.length === 0, "EMERGENCY_APPROVAL", `Unknown emergency override keys: ${unknownOverride.join(", ")}`);
      invariant(typeof value.emergencyOverride.approvedBy === "string" && value.emergencyOverride.approvedBy.trim(), "EMERGENCY_APPROVAL", "Emergency removal needs an approver");
      invariant(typeof value.emergencyOverride.reason === "string" && value.emergencyOverride.reason.trim(), "EMERGENCY_APPROVAL", "Emergency removal needs a reason");
      invariant(isRfc3339Timestamp(value.emergencyOverride.approvedAt), "EMERGENCY_APPROVAL", "Emergency removal needs an RFC3339 approval timestamp");
      lifecycle.emergencyOverride = {
        approvedBy: value.emergencyOverride.approvedBy.trim(),
        reason: value.emergencyOverride.reason.trim(),
        approvedAt: new Date(value.emergencyOverride.approvedAt).toISOString()
      };
    } else invariant(value.emergencyOverride === undefined, "EMERGENCY_APPROVAL", "emergencyOverride is allowed only for immediate removal");
  }
  if (value.message !== undefined) {
    invariant(typeof value.message === "string" && value.message.trim(), "LIFECYCLE_INVALID", "Lifecycle message must be a non-empty string");
    lifecycle.message = value.message;
  }
  return lifecycle;
}

function uniqueTargets(values) {
  invariant(Array.isArray(values), "TARGETS_INVALID", "Targets must be an array");
  const byKey = new Map();
  for (const value of values) {
    const target = normalizeTarget(value);
    byKey.set(targetKey(target), target);
  }
  return [...byKey.values()].sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
}
