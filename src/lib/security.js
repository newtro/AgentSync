import { SkillMeshError } from "./errors.js";

const RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g]
];

export function scanText(text, location = "content") {
  const findings = [];
  for (const [rule, pattern] of RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ rule, location, offset: match.index, value: "[REDACTED]" });
    }
  }
  return findings;
}

export function scanBuffer(content, location = "content") {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const views = [
    [location, buffer.toString("utf8")],
    [`${location} (byte-scan)`, buffer.toString("latin1")]
  ];
  if (buffer.length >= 2) {
    views.push([`${location} (utf16le-scan)`, buffer.toString("utf16le")]);
    const swapped = Buffer.from(buffer);
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const first = swapped[index];
      swapped[index] = swapped[index + 1];
      swapped[index + 1] = first;
    }
    views.push([`${location} (utf16be-scan)`, swapped.toString("utf16le")]);
  }
  return views.flatMap(([viewLocation, text]) => scanText(text, viewLocation));
}

export function assertSecure(entries, revision = "working-tree") {
  const findings = entries.flatMap(({ path, content }) => Buffer.isBuffer(content) ? scanBuffer(content, path) : scanText(content, path));
  if (findings.length) {
    throw new SkillMeshError("SECURITY_BLOCK", `Security scan blocked publication for ${revision}`, {
      revision,
      findings,
      requiresCredentialAssessment: true,
      requiresHistoryRemediation: revision !== "working-tree"
    });
  }
}

export function redact(value) {
  let output = String(value);
  for (const [, pattern] of RULES) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, "[REDACTED]");
  }
  output = output.replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]");
  return output;
}
