#!/usr/bin/env node
// crew - the general build/review/verify engine behind the build-to-complete skill.
// Project-agnostic: intake and outtake live in the caller, the engine owns the middle.
// Usage: crew.mjs <command> [...]   (run `crew.mjs help` for the full list)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CONFIG_RELATIVE_PATH,
  availableReviewers,
  capture,
  defaultConfig,
  die,
  ensureState,
  formatBrief,
  gitc,
  has,
  loadConfig,
  parseBrief,
  repoRoot,
  repoSlug,
  stamp,
  statePaths,
  writeJson,
} from "./lib.mjs";

const REPORT_SENTINEL = "REPORT-END";

const [, , command, ...rest] = process.argv;
const root = repoRoot();
const config = loadConfig(root);
const paths = statePaths(root, config);

const flags = parseFlags(rest);
const positional = flags._;

function parseFlags(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function emit(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

const commands = {
  help: () =>
    emit(
      [
        "crew <command>",
        "",
        "  init                                 write .claude/crew.json from what the repo already declares",
        "  config [--json]                      show the effective config (declared merged over inferred)",
        "  doctor [--json]                      check git, worktrees, reviewers, verify commands",
        "  status [--json]                      queue depth, running briefs, live worktrees",
        "",
        "  worktree add <slug> <branch> [base]  create an isolated worktree for one unit of work",
        "  worktree list [--json]               list crew-managed worktrees",
        "  worktree rm <slug> [--force]         remove a worktree and prune",
        "",
        "  queue add --role R --worktree W [--id ID] [--tier T] [--file F]",
        "                                       enqueue a brief (body from --file, else stdin)",
        "  queue next [--json]                  claim the oldest brief; prints nothing, exits 1 when empty",
        "  queue done <brief> <done|failed> [reason]",
        "  queue list [--json]",
        "",
        "  review <worktree> <brief> <report> [--provider codex|claude|grok] [--model M]",
        "                                       adversarial review in a read-only sandbox",
        "  verify [--in <worktree>] [--only test,build,lint,typecheck]",
        "                                       run the project's own verification commands",
        "",
        "  tier <role>                          print the model for a role (orchestrator/executor/reviewer/verifier/validator/scout)",
      ].join("\n"),
    ),

  init: () => {
    const file = path.join(root, CONFIG_RELATIVE_PATH);
    if (fs.existsSync(file) && !flags.force) die(`${CONFIG_RELATIVE_PATH} already exists (use --force to overwrite)`);
    const inferred = defaultConfig(root);
    writeJson(file, inferred);
    emit(`wrote ${file}`);
    emit(JSON.stringify(inferred, null, 2));
  },

  config: () => {
    const { _source, _file, ...effective } = config;
    if (flags.json) return emit({ source: _source, file: _file, ...effective });
    emit(`source: ${_source} (${_file})`);
    emit(JSON.stringify(effective, null, 2));
  },

  doctor: () => {
    const report = {
      repo: root,
      slug: repoSlug(root),
      state: paths.base,
      configSource: config._source,
      git: has("git"),
      reviewers: Object.fromEntries(availableReviewers().map((name) => [name, has(name)])),
      verify: config.verify,
      tiers: config.tiers,
      worktrees: listWorktrees().length,
      queued: countQueue(),
    };
    if (flags.json) return emit(report);
    emit(`repo        ${report.repo}`);
    emit(`state       ${report.state}`);
    emit(`config      ${report.configSource}${report.configSource === "inferred" ? " (run `crew init` to pin it)" : ""}`);
    emit(`reviewers   ${Object.entries(report.reviewers).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join("  ")}`);
    emit(`verify      ${Object.keys(report.verify).length ? JSON.stringify(report.verify) : "none detected - declare it in crew.json"}`);
    emit(`tiers       ${JSON.stringify(report.tiers)}`);
    emit(`worktrees   ${report.worktrees}`);
    emit(`queue       ${report.queued.pending} pending / ${report.queued.running} running / ${report.queued.done} done`);
  },

  status: () => {
    const value = { queue: countQueue(), worktrees: listWorktrees() };
    if (flags.json) return emit(value);
    emit(`queue      ${value.queue.pending} pending / ${value.queue.running} running / ${value.queue.done} done`);
    for (const tree of value.worktrees) emit(`worktree   ${tree.slug.padEnd(24)} ${tree.branch}`);
  },

  tier: () => {
    const role = positional[0];
    if (!role) die("usage: crew tier <role>");
    const model = config.tiers[role];
    if (!model) die(`unknown role "${role}" (known: ${Object.keys(config.tiers).join(", ")})`);
    emit(model);
  },

  worktree: () => {
    const action = positional[0];
    if (action === "add") {
      const [, slug, branch, base] = positional;
      if (!slug || !branch) die("usage: crew worktree add <slug> <branch> [base]");
      ensureState(paths);
      const dir = path.join(paths.worktrees, slug);
      if (fs.existsSync(dir)) die(`${dir} already exists`);
      const baseRef = base ?? defaultBase();
      try {
        gitc(root, ["fetch", "--quiet", "--all"]);
      } catch {
        // offline is survivable; the checkout below will fail loudly if the ref is genuinely missing
      }
      const exists = capture("git", ["-C", root, "rev-parse", "--verify", "--quiet", branch]) !== null;
      const args = exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, baseRef];
      execFileSync("git", ["-C", root, ...args], { stdio: "inherit" });
      emit(`WORKTREE=${dir}`);
      emit(`BRANCH=${branch}`);
      emit(`BASE=${capture("git", ["-C", root, "rev-parse", "--short", baseRef]) ?? baseRef}`);
      return;
    }
    if (action === "list") {
      const trees = listWorktrees();
      if (flags.json) return emit(trees);
      for (const tree of trees) emit(`${tree.slug.padEnd(24)} ${tree.branch.padEnd(40)} ${tree.path}`);
      return;
    }
    if (action === "rm") {
      const slug = positional[1];
      if (!slug) die("usage: crew worktree rm <slug> [--force]");
      const dir = path.join(paths.worktrees, slug);
      if (!fs.existsSync(dir)) die(`no such worktree: ${dir}`);
      execFileSync("git", ["-C", root, "worktree", "remove", ...(flags.force ? ["--force"] : []), dir], { stdio: "inherit" });
      gitc(root, ["worktree", "prune"]);
      emit(`removed ${dir}`);
      return;
    }
    die("usage: crew worktree <add|list|rm> ...");
  },

  queue: () => {
    const action = positional[0];
    ensureState(paths);
    if (action === "add") {
      const role = flags.role ?? "executor";
      const worktree = flags.worktree;
      if (!worktree) die("usage: crew queue add --role <role> --worktree <slug> [--id ID] [--tier T] [--file F]");
      const id = flags.id ?? `${role}-${stamp()}`;
      const tier = flags.tier ?? config.tiers[role] ?? config.tiers.executor;
      const body = flags.file ? fs.readFileSync(flags.file, "utf8") : fs.readFileSync(0, "utf8");
      if (!body.trim()) die("brief body is empty (pass --file or pipe it on stdin)");
      const report = path.join(paths.reports, `${id}.md`);
      const target = path.join(paths.queue, `${stamp()}-${id}.md`);
      fs.writeFileSync(
        target,
        formatBrief({ id, role, tier, worktree: path.join(paths.worktrees, worktree), report }, body),
      );
      emit(flags.json ? { brief: target, report, tier } : `QUEUED=${target}\nREPORT=${report}\nTIER=${tier}`);
      return;
    }
    if (action === "next") {
      const pending = fs
        .readdirSync(paths.queue)
        .filter((name) => name.endsWith(".md"))
        .sort();
      if (!pending.length) process.exit(1);
      const from = path.join(paths.queue, pending[0]);
      const to = path.join(paths.running, pending[0]);
      fs.renameSync(from, to); // rename is atomic on one filesystem: two workers cannot claim the same brief
      const { meta } = parseBrief(fs.readFileSync(to, "utf8"));
      if (flags.json) return emit({ brief: to, ...meta });
      emit(`brief: ${to}`);
      for (const [key, value] of Object.entries(meta)) emit(`${key}: ${value}`);
      return;
    }
    if (action === "done") {
      const [, brief, state, ...reason] = positional;
      if (!brief || !["done", "failed"].includes(state)) die("usage: crew queue done <brief> <done|failed> [reason]");
      if (!fs.existsSync(brief)) die(`no such brief: ${brief}`);
      const target = path.join(paths.done, `${state}-${path.basename(brief)}`);
      fs.renameSync(brief, target);
      if (reason.length) fs.appendFileSync(target, `\n<!-- ${state}: ${reason.join(" ")} -->\n`);
      emit(`${state}: ${target}`);
      return;
    }
    if (action === "list") {
      const value = {
        pending: fs.readdirSync(paths.queue).filter((n) => n.endsWith(".md")),
        running: fs.readdirSync(paths.running).filter((n) => n.endsWith(".md")),
        done: fs.readdirSync(paths.done).filter((n) => n.endsWith(".md")),
      };
      if (flags.json) return emit(value);
      for (const [state, items] of Object.entries(value)) for (const item of items) emit(`${state.padEnd(8)} ${item}`);
      return;
    }
    die("usage: crew queue <add|next|done|list> ...");
  },

  review: () => {
    const [worktree, brief, report] = positional;
    if (!worktree || !brief || !report) die("usage: crew review <worktree> <brief> <report> [--provider P] [--model M]");
    if (!fs.existsSync(worktree)) die(`no such worktree: ${worktree}`);
    if (!fs.existsSync(brief)) die(`no such brief: ${brief}`);
    const provider = flags.provider ?? availableReviewers()[0];
    fs.mkdirSync(path.dirname(report), { recursive: true });
    const prompt = `${fs.readFileSync(brief, "utf8")}\n\nWrite the full report in the exact shape the brief specifies as your final message.\n`;
    const log = path.join(paths.logs, `${path.basename(report)}.${provider}.log`);
    fs.mkdirSync(paths.logs, { recursive: true });

    let result;
    if (provider === "codex") {
      const args = ["exec", "-C", worktree, "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "-o", report];
      if (flags.model) args.push("-m", flags.model);
      result = spawnSync("codex", [...args, "-"], { input: prompt, encoding: "utf8" });
    } else if (provider === "claude") {
      const model = flags.model ?? config.tiers.reviewer;
      result = spawnSync("claude", ["-p", "--model", model, "--permission-mode", "plan"], {
        input: prompt,
        cwd: worktree,
        encoding: "utf8",
      });
      if (result.status === 0 && result.stdout) fs.writeFileSync(report, result.stdout);
    } else if (provider === "grok") {
      const promptFile = `${report}.prompt`;
      fs.writeFileSync(promptFile, `${prompt}Do not modify any file.\n`);
      const args = [
        "--prompt-file", promptFile,
        "--cwd", worktree,
        "--sandbox", "read-only",
        "--always-approve",
        "--output-format", "plain",
        "--no-subagents",
        "--max-turns", "300",
        "--disable-web-search",
      ];
      if (flags.model) args.push("-m", flags.model);
      result = spawnSync("grok", args, { encoding: "utf8" });
      fs.rmSync(promptFile, { force: true });
      if (result.status === 0 && result.stdout) fs.writeFileSync(report, result.stdout);
    } else {
      die(`unknown review provider: ${provider}`);
    }

    fs.writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (result.status !== 0 || !fs.existsSync(report) || !fs.statSync(report).size) {
      die(`${provider} review FAILED (rc=${result.status}); see ${log}`, 2);
    }
    fs.appendFileSync(report, `\n${REPORT_SENTINEL}\n`);
    emit(`${provider} review written: ${report}`);
  },

  verify: () => {
    const cwd = flags.in ? path.resolve(flags.in) : root;
    const only = flags.only && flags.only !== true ? String(flags.only).split(",").map((s) => s.trim()) : null;
    // narrowest first: a type error should surface before a full integration suite runs
    const order = ["typecheck", "lint", "test", "build"];
    const selected = order.filter((name) => config.verify[name] && (!only || only.includes(name)));
    if (!selected.length) die("no verify commands configured - run `crew init` or declare verify in crew.json");
    const results = [];
    for (const name of selected) {
      const command = config.verify[name];
      process.stdout.write(`\n=== ${name}: ${command} ===\n`);
      const shell = process.platform === "win32" ? ["cmd", ["/c", command]] : ["sh", ["-c", command]];
      const run = spawnSync(shell[0], shell[1], { cwd, stdio: "inherit" });
      results.push({ name, command, ok: run.status === 0, status: run.status });
      if (run.status !== 0) break; // stop at the first failure; fix it before widening
    }
    const failed = results.find((entry) => !entry.ok);
    if (flags.json) emit({ cwd, results, ok: !failed });
    else emit(`\n${failed ? `FAILED at ${failed.name}` : `passed: ${results.map((r) => r.name).join(", ")}`}`);
    if (failed) process.exit(1);
  },
};

function defaultBase() {
  const head = capture("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (capture("git", ["-C", root, "rev-parse", "--verify", "--quiet", candidate])) return candidate;
  }
  return "HEAD";
}

function listWorktrees() {
  const raw = capture("git", ["-C", root, "worktree", "list", "--porcelain"]) ?? "";
  const trees = [];
  let current = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = { path: line.slice(9) };
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "") {
      if (current.path?.startsWith(paths.worktrees)) {
        trees.push({ slug: path.basename(current.path), branch: current.branch ?? "(detached)", path: current.path });
      }
      current = {};
    }
  }
  if (current.path?.startsWith(paths.worktrees)) {
    trees.push({ slug: path.basename(current.path), branch: current.branch ?? "(detached)", path: current.path });
  }
  return trees;
}

function countQueue() {
  const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".md")).length : 0);
  return { pending: count(paths.queue), running: count(paths.running), done: count(paths.done) };
}

const handler = commands[command ?? "help"];
if (!handler) die(`unknown command "${command}" (try: crew help)`);
handler();
