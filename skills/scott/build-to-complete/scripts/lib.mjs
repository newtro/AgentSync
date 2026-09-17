// Shared helpers for the build-to-complete crew engine.
// Node standard library only, so the skill runs unchanged on darwin and windows.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TIERS = {
  orchestrator: "opus",
  executor: "opus",
  reviewer: "opus",
  verifier: "sonnet",
  validator: "sonnet",
  scout: "haiku",
};

export const CONFIG_RELATIVE_PATH = path.join(".claude", "crew.json");

export function die(message, code = 1) {
  process.stderr.write(`crew: ${message}\n`);
  process.exit(code);
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) die(`${file} is not valid JSON: ${error.message}`);
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export function has(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  return capture(probe, [command]) !== null;
}

export function repoRoot(from = process.cwd()) {
  const root = capture("git", ["-C", from, "rev-parse", "--show-toplevel"]);
  if (!root) die(`not inside a git repository: ${from}`);
  return path.resolve(root);
}

export function repoSlug(root) {
  const digest = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);
  const name = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${name || "repo"}-${digest}`;
}

// State never lives inside the project: no stray files, no gitignore edits, one place to clean.
export function stateRoot(root, config = {}) {
  if (process.env.CREW_STATE_ROOT) return path.resolve(process.env.CREW_STATE_ROOT);
  if (config.stateRoot) return path.resolve(root, config.stateRoot);
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(home, "crew", repoSlug(root));
}

export function statePaths(root, config = {}) {
  const base = stateRoot(root, config);
  return {
    base,
    queue: path.join(base, "queue"),
    running: path.join(base, "queue", "running"),
    done: path.join(base, "queue", "done"),
    reports: path.join(base, "reports"),
    worktrees: path.join(base, "worktrees"),
    logs: path.join(base, "logs"),
  };
}

export function ensureState(paths) {
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  return paths;
}

const VERIFY_PROBES = [
  {
    detect: (root) => fs.existsSync(path.join(root, "package.json")),
    build: (root) => {
      const scripts = readJson(path.join(root, "package.json"), {}).scripts ?? {};
      const pick = (...names) => names.find((name) => scripts[name]);
      const runner = fs.existsSync(path.join(root, "pnpm-lock.yaml"))
        ? "pnpm"
        : fs.existsSync(path.join(root, "yarn.lock"))
          ? "yarn"
          : "npm run";
      const cmd = (name) => (name ? `${runner} ${name}`.replace("npm run test", "npm test") : null);
      return {
        test: cmd(pick("test", "tests", "spec")),
        build: cmd(pick("build", "compile")),
        lint: cmd(pick("lint", "eslint")),
        typecheck: cmd(pick("typecheck", "types", "tsc")),
      };
    },
  },
  {
    detect: (root) => globFirst(root, /\.(?:sln|slnf|csproj)$/i) !== null,
    build: () => ({ test: "dotnet test", build: "dotnet build", lint: null, typecheck: null }),
  },
  {
    detect: (root) => ["pyproject.toml", "pytest.ini", "setup.cfg"].some((f) => fs.existsSync(path.join(root, f))),
    build: () => ({ test: "pytest", build: null, lint: "ruff check .", typecheck: null }),
  },
  {
    detect: (root) => fs.existsSync(path.join(root, "Cargo.toml")),
    build: () => ({ test: "cargo test", build: "cargo build", lint: "cargo clippy", typecheck: null }),
  },
  {
    detect: (root) => fs.existsSync(path.join(root, "go.mod")),
    build: () => ({ test: "go test ./...", build: "go build ./...", lint: null, typecheck: "go vet ./..." }),
  },
];

function globFirst(root, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) if (entry.isFile() && pattern.test(entry.name)) return entry.name;
  return null;
}

export function inferVerify(root) {
  for (const probe of VERIFY_PROBES) {
    if (!probe.detect(root)) continue;
    const found = probe.build(root);
    return Object.fromEntries(Object.entries(found).filter(([, value]) => value));
  }
  return {};
}

export function inferRun(root) {
  const launch = readJson(path.join(root, ".claude", "launch.json"), null);
  const first = launch?.configurations?.[0]?.name;
  return first ? { name: first } : {};
}

export function defaultConfig(root) {
  return {
    version: 1,
    verify: inferVerify(root),
    run: inferRun(root),
    parallel: { maxWorkers: 3 },
    tiers: { ...DEFAULT_TIERS },
    reviewers: availableReviewers(),
    outtake: "branch",
  };
}

export function availableReviewers() {
  const found = [];
  if (has("codex")) found.push("codex");
  if (has("claude")) found.push("claude");
  if (has("grok")) found.push("grok");
  return found.length ? found : ["claude"];
}

// Explicit config wins over inference; inference only fills gaps, never overrides.
export function loadConfig(root) {
  const file = path.join(root, CONFIG_RELATIVE_PATH);
  const declared = readJson(file, null);
  const base = defaultConfig(root);
  if (!declared) return { ...base, _source: "inferred", _file: file };
  return {
    ...base,
    ...declared,
    verify: { ...base.verify, ...(declared.verify ?? {}) },
    run: { ...base.run, ...(declared.run ?? {}) },
    parallel: { ...base.parallel, ...(declared.parallel ?? {}) },
    tiers: { ...base.tiers, ...(declared.tiers ?? {}) },
    _source: "declared",
    _file: file,
  };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseBrief(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key) meta[key] = line.slice(separator + 1).trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

export function formatBrief(meta, body) {
  const head = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}

export function gitc(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", ...options }).trim();
}

export function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
