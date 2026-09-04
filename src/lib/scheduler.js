import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { invariant } from "./errors.js";

export function schedulePlan({ nodePlatform = process.platform, executable, commandArgs = ["sync"], home = os.homedir(), intervalMinutes = 15 }) {
  invariant(Number.isSafeInteger(intervalMinutes) && intervalMinutes >= 5, "SCHEDULE_INTERVAL", "Schedule interval must be at least five minutes");
  if (nodePlatform === "darwin") {
    const filePath = path.join(home, "Library", "LaunchAgents", "io.skillmesh.sync.plist");
    const argumentsXml = [executable, ...commandArgs].map((value) => `<string>${xml(value)}</string>`).join("");
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>io.skillmesh.sync</string>\n<key>ProgramArguments</key><array>${argumentsXml}</array>\n<key>StartInterval</key><integer>${intervalMinutes * 60}</integer>\n<key>RunAtLoad</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(home, ".skillmesh", "scheduler.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(home, ".skillmesh", "scheduler.log"))}</string>\n</dict></plist>\n`;
    return { platform: "darwin", filePath, content, command: ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? "UID"}`, filePath] };
  }
  if (nodePlatform === "win32") {
    const filePath = path.join(home, ".skillmesh", "SkillMesh-Sync.xml");
    const command = process.env.ComSpec || "cmd.exe";
    const cmdLine = `"${[executable, ...commandArgs].map(windowsQuote).join(" ")}"`;
    const content = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><CalendarTrigger><Repetition><Interval>PT${intervalMinutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><RandomDelay>PT2M</RandomDelay><Enabled>true</Enabled></CalendarTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(`/d /s /c ${cmdLine}`)}</Arguments></Exec></Actions></Task>\n`;
    return { platform: "windows", filePath, content, encoding: "utf16le", command: ["schtasks.exe", "/Create", "/TN", "SkillMesh-Sync", "/XML", filePath, "/F"] };
  }
  throw new Error(`Unsupported scheduler platform: ${nodePlatform}`);
}

export async function installSchedule(options) {
  const plan = schedulePlan(options);
  if (options.dryRun) return plan;
  await mkdir(path.dirname(plan.filePath), { recursive: true });
  await writeFile(plan.filePath, plan.content, plan.encoding ?? "utf8");
  await run(plan.command[0], plan.command.slice(1));
  return plan;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}`)));
  });
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function windowsQuote(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}
