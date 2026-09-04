import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { SkillMeshError } from "./errors.js";
import { redact } from "./security.js";

export async function runGit(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new SkillMeshError("GIT_UNAVAILABLE", error.message)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new SkillMeshError("GIT_FAILED", `Git operation failed (${args[0]}): ${redact(stderr.trim())}`));
    });
  });
}

export async function cloneOrUpdate(repo, destination) {
  let exists = true;
  try {
    await access(destination);
  } catch {
    exists = false;
  }
  if (!exists) {
    await mkdir(path.dirname(destination), { recursive: true });
    await runGit(["clone", "--filter=blob:none", repo, destination]);
    return destination;
  }
  const origin = await runGit(["remote", "get-url", "origin"], { cwd: destination });
  if (canonicalRepoIdentity(origin) !== canonicalRepoIdentity(repo)) throw new SkillMeshError("REPO_MISMATCH", "Managed checkout points to a different repository");
  await runGit(["fetch", "--prune", "origin"], { cwd: destination });
  const branch = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: destination }).catch(() => "origin/main");
  await runGit(["checkout", "--detach", branch], { cwd: destination });
  return destination;
}

export function validateRepoPointer(value) {
  if (typeof value !== "string" || !value.trim()) throw new SkillMeshError("REPO_POINTER", "Repository pointer is required");
  const pointer = value.trim();
  if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(pointer)) return pointer;
  if (/^https?:/.test(pointer)) {
    const url = new URL(pointer);
    if (url.username || url.password || url.search || url.hash) throw new SkillMeshError("REPO_CREDENTIAL", "Repository pointers may not embed credentials, query parameters, or fragments");
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)) throw new SkillMeshError("REPO_POINTER", "Network repository pointers must be standard HTTPS GitHub repository URLs");
    return pointer;
  }
  if (pointer.startsWith("file:")) {
    const url = new URL(pointer);
    if (url.username || url.password || url.search || url.hash) throw new SkillMeshError("REPO_CREDENTIAL", "Repository pointers may not embed credentials, query parameters, or fragments");
    return pointer;
  }
  if (pointer.startsWith("/")) return pointer;
  throw new SkillMeshError("REPO_POINTER", "Use a GitHub HTTPS/SSH URL, file URL, or absolute local path");
}

export function repositoryIdentity(value) {
  const pointer = validateRepoPointer(value);
  if (pointer.startsWith("/")) return `file:${path.resolve(pointer)}`;
  if (pointer.startsWith("file:")) return `file:${path.resolve(new URL(pointer).pathname)}`;
  return pointer.replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//i, "github:").replace(/^git@github\.com:/i, "github:").toLowerCase();
}

export function sameRepository(left, right) {
  return repositoryIdentity(left) === repositoryIdentity(right);
}

function canonicalRepoIdentity(value) {
  return repositoryIdentity(value);
}
