import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { digestFiles } from "./compiler.js";
import { invariant } from "./errors.js";

export async function readTree(root, options = {}) {
  const rootStat = await lstat(root);
  invariant(!rootStat.isSymbolicLink() && rootStat.isDirectory(), "SYMLINK_FORBIDDEN", `Managed artifact root must be a real directory: ${root}`);
  const files = new Map();
  await walk(root, "", files, options.exclude ?? new Set());
  return files;
}

export async function digestTree(root, options) {
  const files = await readTree(root, options);
  if (process.platform !== "win32" && files.has("skillmesh-projection.json")) {
    const metadata = JSON.parse(files.get("skillmesh-projection.json").toString("utf8"));
    const expected = new Set(metadata.executableFiles ?? []);
    for (const relative of expected) {
      invariant(files.has(relative), "EXECUTABLE_MISSING", `Declared executable is missing: ${relative}`);
      invariant(((await stat(path.join(root, ...relative.split("/")))).mode & 0o111) !== 0, "EXECUTABLE_MODE", `Declared executable lacks an executable bit: ${relative}`);
    }
  }
  return digestFiles(files);
}

async function walk(root, relative, files, exclude) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const portable = child.split(path.sep).join("/");
    if (exclude.has(portable)) continue;
    invariant(!entry.isSymbolicLink(), "SYMLINK_FORBIDDEN", `Managed artifacts may not contain symlinks: ${portable}`);
    if (entry.isDirectory()) await walk(root, child, files, exclude);
    else if (entry.isFile()) files.set(portable, await readFile(path.join(root, child)));
    else invariant(false, "FILE_INVALID", `Unsupported artifact entry: ${portable}`);
  }
}
