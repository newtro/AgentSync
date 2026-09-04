import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { loadCanonicalSkill } from "./compiler.js";
import { invariant } from "./errors.js";

export async function discoverSkills(sourceRoot) {
  const skillsRoot = path.join(sourceRoot, "skills");
  const manifests = await walkForManifest(skillsRoot);
  const canonical = [];
  const ids = new Map();
  for (const manifestPath of manifests.sort()) {
    const skill = await loadCanonicalSkill(path.dirname(manifestPath));
    const folded = skill.manifest.id.toLocaleLowerCase("en-US");
    invariant(!ids.has(folded), "ID_DUPLICATE", `Duplicate or case-only skill id: ${skill.manifest.id}`);
    ids.set(folded, manifestPath);
    canonical.push({ ...skill, directory: path.dirname(manifestPath) });
  }
  return canonical.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}
async function walkForManifest(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const results = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) results.push(...await walkForManifest(absolute));
    if (entry.isFile() && entry.name === "skill.json") results.push(absolute);
  }
  return results;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
