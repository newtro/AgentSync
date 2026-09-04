import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { adapterPlan, createEnrollments } from "./adapters.js";
import { invariant } from "./errors.js";
import { cloneOrUpdate, runGit, sameRepository, validateRepoPointer } from "./git.js";
import { stableStringify } from "./json.js";
import { probeCapabilities } from "./probe.js";
import { installSchedule } from "./scheduler.js";

export function defaultStateRoot(home = os.homedir()) {
  return path.join(home, ".skillmesh");
}

export async function createManagedLauncher({ stateRoot, nodePlatform = process.platform, nodeExecutable = process.execPath, cliPath }) {
  const binRoot = path.join(stateRoot, "bin");
  await mkdir(binRoot, { recursive: true, mode: 0o700 });
  if (nodePlatform === "win32") {
    const launcher = path.join(binRoot, "skillmesh.cmd");
    await writeFile(launcher, `@echo off\r\n"${nodeExecutable}" "${cliPath}" %*\r\n`, { mode: 0o700 });
    return launcher;
  }
  const launcher = path.join(binRoot, "skillmesh");
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(nodeExecutable)} ${quote(cliPath)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  return launcher;
}

export async function onboard(repoPointer, options = {}) {
  const sourceRepo = validateRepoPointer(repoPointer);
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? defaultStateRoot(home);
  const sourceCheckout = path.join(stateRoot, "repos", "source");
  await mkdir(path.dirname(sourceCheckout), { recursive: true, mode: 0o700 });
  await (options.cloneOrUpdate ?? cloneOrUpdate)(sourceRepo, sourceCheckout);
  const repositoryConfig = JSON.parse(await readFile(path.join(sourceCheckout, "skillmesh.config.json"), "utf8"));
  invariant(repositoryConfig.schemaVersion === 1, "CONFIG_SCHEMA", "Unsupported repository configuration schema");
  const distributionRepo = validateRepoPointer(repositoryConfig.distributionRepo);
  invariant(!sameRepository(distributionRepo, sourceRepo), "DISTRIBUTION_BOUNDARY", "Distribution repository must differ from source repository");
  const distributionCheckout = path.join(stateRoot, "repos", "distribution");
  await (options.cloneOrUpdate ?? cloneOrUpdate)(distributionRepo, distributionCheckout);

  const capabilities = await (options.probeCapabilities ?? probeCapabilities)({ home });
  const projectRoots = await validateProjectRoots(options.projectRoots ?? []);
  const enrollments = createEnrollments({ home, machine: options.machine ?? os.hostname(), projectRoots, nodePlatform: options.nodePlatform ?? process.platform }).map((enrollment) => {
    const capability = capabilities.targets?.find((item) => item.harness === enrollment.harness && item.profile === enrollment.profile)
      ?? capabilities.targets?.find((item) => item.harness === enrollment.harness);
    const scopeSupported = capability?.scopes?.includes(enrollment.scope) ?? true;
    const installRoot = enrollment.mode === "direct" && enrollment.scope === "global" && capability?.preferredGlobalPath
      ? capability.preferredGlobalPath
      : enrollment.installRoot;
    return { ...enrollment, installRoot, capabilityState: capability?.state ?? "unknown", enabled: capability?.state !== "unsupported" && scopeSupported, ...(scopeSupported ? {} : { disabledReason: "Capability probe did not advertise this scope" }) };
  });
  const plans = enrollments.map((enrollment) => ({ endpointId: enrollment.id, ...adapterPlan(enrollment, distributionRepo) }));
  const config = {
    schemaVersion: 1,
    sourceRepo,
    distributionRepo,
    sourceCheckout,
    distributionCheckout,
    stateRoot,
    updaterExecutable: options.updaterExecutable ?? null,
    enrollments,
    capabilities,
    scheduleState: options.executable ? "pending" : "not-configured",
    onboardedAt: (options.now ?? new Date()).toISOString()
  };
  const preCommit = options.preCommit ? await options.preCommit(config) : null;
  const configPath = path.join(stateRoot, "config.json");
  const configStage = `${configPath}.stage`;
  await writeFile(configStage, stableStringify(config), { mode: 0o600 });
  await rename(configStage, configPath);
  let schedule = null;
  if (options.executable) {
    schedule = await (options.installSchedule ?? installSchedule)({
      nodePlatform: options.nodePlatform ?? process.platform,
      executable: options.executable,
      commandArgs: options.commandArgs ?? ["sync", "--scheduled"],
      home,
      intervalMinutes: 15,
      dryRun: options.dryRunSchedule ?? false
    });
    config.scheduleState = options.dryRunSchedule ? "planned" : "installed";
    const scheduleConfigStage = `${configPath}.schedule-stage`;
    await writeFile(scheduleConfigStage, stableStringify(config), { mode: 0o600 });
    await rename(scheduleConfigStage, configPath);
  }
  return { config, plans, schedule, preCommit };
}

async function validateProjectRoots(values) {
  const roots = [];
  const seen = new Set();
  for (const value of values) {
    const resolved = await realpath(value);
    if (seen.has(resolved)) continue;
    const info = await stat(resolved);
    invariant(info.isDirectory(), "PROJECT_ROOT", `Project root is not a directory: ${value}`);
    const gitRoot = await runGit(["rev-parse", "--show-toplevel"], { cwd: resolved }).catch(() => null);
    invariant(gitRoot && path.resolve(gitRoot) === path.resolve(resolved), "PROJECT_ROOT", `Project root must be the root of a Git repository: ${value}`);
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

export async function readEndpointConfig(stateRoot = defaultStateRoot()) {
  return JSON.parse(await readFile(path.join(stateRoot, "config.json"), "utf8"));
}
