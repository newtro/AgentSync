import { spawn } from "node:child_process";

import { SkillMeshError } from "./errors.js";
import { redact } from "./security.js";

export function validateClaudePackage(packagePath) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "claude";
    const claudeArgs = ["plugin", "validate", "--strict", packagePath];
    const quote = (value) => `"${String(value).replace(/%/g, "%%").replace(/"/g, '""')}"`;
    const args = windows ? ["/d", "/s", "/c", `"${["claude.cmd", ...claudeArgs].map(quote).join(" ")}"`] : claudeArgs;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new SkillMeshError("CLAUDE_VALIDATOR_UNAVAILABLE", `Claude strict validator is unavailable: ${redact(error.message)}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new SkillMeshError("CLAUDE_VALIDATION_FAILED", `Claude strict validation failed for generated package: ${redact(stderr || stdout)}`));
    });
  });
}
