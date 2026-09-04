import { spawn } from "node:child_process";

import { SkillMeshError } from "./errors.js";
import { redact } from "./security.js";

export function validateClaudePackage(packagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["plugin", "validate", "--strict", packagePath], { stdio: ["ignore", "pipe", "pipe"] });
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
