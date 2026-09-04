import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { stableStringify } from "./json.js";
import { redact } from "./security.js";

export async function shouldRunScheduled(stateRoot, now = new Date()) {
  const control = await readJsonSafe(path.join(stateRoot, "sync-control.json"));
  return !control?.nextAttemptAt || now.getTime() >= Date.parse(control.nextAttemptAt);
}
export async function recordSyncAttempt({ stateRoot, statuses, error, now = new Date(), random = Math.random }) {
  const controlPath = path.join(stateRoot, "sync-control.json");
  const previous = await readJsonSafe(controlPath);
  const failed = Boolean(error) || statuses?.some((status) => status.state === "failed");
  const failureCount = failed ? (previous?.failureCount ?? 0) + 1 : 0;
  const delayMs = failed
    ? Math.min(3_600_000, 60_000 * (2 ** Math.min(failureCount - 1, 6))) + Math.floor(random() * 30_000)
    : 13 * 60_000 + Math.floor(random() * 4 * 60_000);
  const control = { lastAttemptAt: now.toISOString(), lastAttemptState: failed ? "failed" : "completed", failureCount, nextAttemptAt: new Date(now.getTime() + delayMs).toISOString() };
  await writeFile(controlPath, stableStringify(control), { mode: 0o600 });

  if (error) {
    const statusPath = path.join(stateRoot, "status.json");
    const old = await readJsonSafe(statusPath) ?? { endpoints: [] };
    await writeFile(statusPath, stableStringify({ ...old, updatedAt: now.toISOString(), syncAttempt: { state: "failed", error: redact(error.message) } }), { mode: 0o600 });
  }
  return control;
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
