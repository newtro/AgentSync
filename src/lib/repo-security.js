import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { assertSecure } from "./security.js";
import { invariant } from "./errors.js";

export async function scanRepository(root, revision = "working-tree") {
  const entries = [];
  await walk(root, "", entries);
  assertSecure(entries, revision);
  return { revision, filesScanned: entries.length, secure: true };
}

async function walk(root, relative, output) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    if (!relative && [".git", ".skillmesh", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const child = relative ? path.join(relative, entry.name) : entry.name;
    invariant(!entry.isSymbolicLink(), "SYMLINK_FORBIDDEN", `Repository content may not contain symlinks: ${child.split(path.sep).join("/")}`);
    if (entry.isDirectory()) await walk(root, child, output);
    else if (entry.isFile()) {
      const content = await readFile(path.join(root, child));
      output.push({ path: child.split(path.sep).join("/"), content });
    }
  }
}
