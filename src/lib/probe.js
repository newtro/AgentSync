import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export async function probeCapabilities(options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const exec = options.exec ?? probeCommand;
  const codex = await exec("codex", ["--version"]);
  const claude = await exec("claude", ["--version"]);
  const desktop = await probeDesktop(platform, exec);
  const desktopInstalled = desktop.available;
  const desktopAbsentReason = desktop.reason ?? "Claude Desktop was not authoritatively discovered; a live provider probe is required";

  const targets = [
    {
      harness: "codex",
      profile: "default",
      state: codex.available ? "available" : "unsupported",
      version: codex.version,
      scopes: ["global", "project"],
      preferredGlobalPath: platform === "win32" ? path.join(home, ".agents", "skills") : path.join(home, ".agents", "skills")
    },
    {
      harness: "claude-code",
      profile: "unbound",
      state: claude.available ? "available" : "unsupported",
      version: claude.version,
      scopes: ["global", "project"],
      preferredGlobalPath: path.join(home, ".claude", "skills")
    },
    {
      harness: "claude-desktop",
      profile: "personal",
      state: desktopInstalled ? "assisted-action-required" : "unknown",
      reason: desktopInstalled ? "No documented unattended personal marketplace refresh interface" : desktopAbsentReason,
      scopes: ["global"]
    },
    {
      harness: "claude-desktop",
      profile: "organization",
      state: "unknown",
      reason: desktopInstalled ? "Organization GitHub App and marketplace state require account-owner verification" : desktopAbsentReason,
      scopes: ["global"]
    }
  ];
  return {
    diagnosticComplete: true,
    platform,
    architecture: process.arch,
    node: process.versions.node,
    ready: targets.every((target) => target.state === "available"),
    targets
  };
}

async function probeDesktop(platform, exec) {
  if (platform === "darwin") {
    const result = await exec("open", ["-Ra", "Claude"]);
    return result.available
      ? { available: true, version: result.version }
      : { available: false, reason: "macOS Launch Services did not discover Claude Desktop; provider state remains unknown" };
  }
  if (platform === "win32") {
    const script = "$p=Get-AppxPackage | Where-Object { $_.Name -match 'Claude' -or $_.PublisherDisplayName -match 'Anthropic' }; if ($p) { $p[0].Version.ToString() } else { exit 1 }";
    const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return result.available
      ? { available: true, version: result.version }
      : { available: false, reason: "Get-AppxPackage did not discover Claude Desktop; native Windows and provider state remain unknown" };
  }
  return { available: false, reason: `Claude Desktop discovery is not implemented for ${platform}` };
}

async function probeCommand(command, args) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ available: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
      resolve({ available: code === 0, version });
    });
  });
}
