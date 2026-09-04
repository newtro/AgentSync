import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { invariant } from "./errors.js";
import { stableStringify } from "./json.js";
import { validateManifest } from "./manifest.js";
import { assertSecure } from "./security.js";
import { normalizeTarget, targetKey, targetMatches } from "./target.js";

export const GENERATOR_VERSION = "1";

export async function loadCanonicalSkill(skillDir) {
  const raw = await readFile(path.join(skillDir, "skill.json"), "utf8");
  assertSecure([{ path: "skill.json", content: raw }]);
  const manifest = validateManifest(JSON.parse(raw));
  const relativeFiles = new Set(manifest.files.map((file) => file.source));
  for (const overlay of manifest.overlays) for (const file of overlay.files) relativeFiles.add(file.source);

  const files = new Map();
  for (const relative of [...relativeFiles].sort()) {
    const absolute = path.resolve(skillDir, relative);
    const root = path.resolve(skillDir) + path.sep;
    invariant(absolute.startsWith(root), "PATH_ESCAPE", `Path escapes skill root: ${relative}`);
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), "SYMLINK_FORBIDDEN", `Canonical files may not be symlinks: ${relative}`);
    invariant(stat.isFile(), "FILE_INVALID", `Canonical entry is not a file: ${relative}`);
    files.set(relative, await readFile(absolute));
  }
  assertSecure([...files].map(([filePath, content]) => ({ path: filePath, content })));
  return { manifest, files };
}

export function compileProjection(canonical, targetInput, sourceCommit = "working-tree", providerRevision = 1) {
  const manifest = validateManifest(canonical.manifest);
  const target = normalizeTarget(targetInput);
  const required = new Set(manifest.targets.required.map(targetKey));
  const denied = new Set(manifest.targets.denied.map(targetKey));
  const key = targetKey(target);
  invariant(!denied.has(key), "TARGET_DENIED", `Target is explicitly denied: ${key}`);
  invariant(required.has(key), "TARGET_NOT_REQUIRED", `Target is not declared required: ${key}`);

  invariant(Number.isSafeInteger(providerRevision) && providerRevision > 0, "PROVIDER_REVISION", "Provider revision must be a positive integer");
  const selected = new Map();
  for (const file of manifest.files) selected.set(file.destination, { content: canonical.files.get(file.source), kind: file.kind, executable: file.executable === true });
  for (const overlay of manifest.overlays) {
    if (targetMatches(overlay.match, target)) {
      for (const file of overlay.files) selected.set(file.destination, { content: canonical.files.get(file.source), kind: file.kind, executable: file.executable === true });
    }
  }
  for (const [relative, file] of selected) invariant(Buffer.isBuffer(file.content), "FILE_MISSING", `Missing canonical file: ${relative}`);

  const skillFile = selected.get("SKILL.md");
  invariant(skillFile?.kind === "text", "SKILL_TEXT_REQUIRED", "SKILL.md must be declared as text");
  const slug = providerSafeName(manifest.id, target);
  if (manifest.lifecycle.state === "removed") {
    const tombstone = `# ${manifest.id} (removed)\n\nThis skill is disabled and must not perform its former behavior.\n`;
    skillFile.content = Buffer.from(ensureSkillFrontmatter(tombstone, manifest, slug));
  } else {
    skillFile.content = Buffer.from(ensureSkillFrontmatter(skillFile.content.toString("utf8"), manifest, slug));
  }

  const files = packageForHarness(manifest, target, selected, providerRevision);
  const executableFiles = [...selected].filter(([, file]) => file.executable).map(([relative]) => target.harness === "codex" ? relative : `skills/${slug}/${relative}`).sort();
  if (manifest.lifecycle.state !== "removed") runSmokeTests(manifest, target, files);
  const payloadDigest = digestFiles(files);
  const metadata = {
    activation: manifest.activation,
    generatorVersion: GENERATOR_VERSION,
    lifecycle: manifest.lifecycle,
    logicalSkillId: manifest.id,
    logicalVersion: manifest.version,
    schemaVersion: manifest.schemaVersion,
    sourceCommit,
    target,
    targetKey: key,
    payloadDigest,
    providerRevision,
    requiredRuntimes: manifest.runtimes,
    executableFiles
  };
  files.set("skillmesh-projection.json", Buffer.from(stableStringify(metadata)));
  assertSecure([...files].map(([filePath, content]) => ({ path: filePath, content })), sourceCommit);
  return { metadata, files, digest: digestFiles(files) };
}

function runSmokeTests(manifest, target, files) {
  const slug = providerSafeName(manifest.id, target);
  for (const test of manifest.smokeTests) {
    if (test.match && !targetMatches(test.match, target)) continue;
    const packaged = target.harness === "codex" ? test.path : `skills/${slug}/${test.path}`;
    const content = files.get(packaged);
    invariant(content, "SMOKE_TEST_FAILED", `Required file is missing for ${targetKey(target)}: ${test.path}`);
    if (test.type === "file-contains") {
      invariant(content.toString("utf8").includes(test.contains), "SMOKE_TEST_FAILED", `Content assertion failed for ${targetKey(target)}: ${test.path}`);
    }
  }
}

export async function writeProjection(projection, outputDir) {
  for (const [relative, content] of [...projection.files].sort(([a], [b]) => a.localeCompare(b))) {
    const destination = path.join(outputDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
    if (process.platform !== "win32" && projection.metadata?.executableFiles?.includes(relative)) await chmod(destination, 0o755);
  }
}

export function digestFiles(files) {
  const hash = createHash("sha256");
  for (const [relative, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relative);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function packageForHarness(manifest, target, selected, providerRevision) {
  const output = new Map();
  if (target.harness === "codex") {
    for (const [relative, file] of selected) output.set(relative, normalizeContent(file));
  } else {
    const slug = providerSafeName(manifest.id, target);
    output.set(".claude-plugin/plugin.json", Buffer.from(stableStringify({
      name: slug,
      description: manifest.description,
      version: `${providerRevision}.0.0`,
      author: { name: "SkillMesh" }
    })));
    for (const [relative, file] of selected) output.set(`skills/${slug}/${relative}`, normalizeContent(file));
  }
  return output;
}

function normalizeContent(file) {
  if (file.kind === "binary") return Buffer.from(file.content);
  const text = file.content.toString("utf8").replace(/\r\n/g, "\n");
  return Buffer.from(text.endsWith("\n") ? text : `${text}\n`);
}

export function providerSafeName(skillId, target) {
  const readable = skillId.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  const identity = target ? `${skillId}\0${providerTargetKey(target)}` : skillId;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  return `${readable}-${suffix}`;
}

export function providerTargetKey(target) {
  const normalized = normalizeTarget(target);
  if (normalized.harness === "claude-code") return `${normalized.harness}--${normalized.os}--shared--${normalized.scope}`;
  if (normalized.harness === "claude-desktop") return `${normalized.harness}--shared--shared--${normalized.scope}`;
  return targetKey(normalized);
}

function ensureSkillFrontmatter(text, manifest, slug) {
  const normalized = text.replace(/\r\n/g, "\n");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---\n", 4);
    invariant(end > 0, "SKILL_FRONTMATTER", "SKILL.md has unterminated frontmatter");
    body = normalized.slice(end + 5).replace(/^\n+/, "");
  }
  const description = JSON.stringify(manifest.description);
  return `---\nname: ${slug}\ndescription: ${description}\n---\n\n${body.endsWith("\n") ? body : `${body}\n`}`;
}
