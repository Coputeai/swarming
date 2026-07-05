// `swarming schedule-daily` — opt-in helper that registers a daily `npx
// swarming run` with the OS scheduler. This is the worker's ONE explicit
// system modification; it prints the exact command and requires y/N consent
// (documented in SECURITY.md).

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

export async function scheduleDaily(): Promise<void> {
  // Random minute in the 01:00–19:00 UTC window (slate is open for hours;
  // spreading load + diversity of submission times).
  const utcHour = 1 + Math.floor(Math.random() * 18);
  const minute = Math.floor(Math.random() * 60);
  const local = new Date(Date.UTC(2000, 0, 1, utcHour, minute));
  const hh = String(local.getHours()).padStart(2, "0");
  const mm = String(local.getMinutes()).padStart(2, "0");

  let description: string;
  let install: () => { ok: boolean; detail: string };

  if (process.platform === "win32") {
    const args = ["/Create", "/F", "/SC", "DAILY", "/ST", `${hh}:${mm}`, "/TN", "Swarming Daily Run", "/TR", "cmd /c npx swarming-cli run"];
    description = `schtasks ${args.join(" ")}`;
    install = () => {
      const r = spawnSync("schtasks", args, { encoding: "utf8" });
      return { ok: r.status === 0, detail: (r.stdout || r.stderr || "").trim() };
    };
  } else {
    const line = `${mm} ${hh} * * * npx swarming-cli run  # swarming-daily`;
    description = `append to your crontab: ${line}`;
    install = () => {
      const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
      const existing = current.status === 0 ? current.stdout : "";
      if (existing.includes("# swarming-daily")) return { ok: true, detail: "already installed" };
      const r = spawnSync("crontab", ["-"], { input: existing + line + "\n", encoding: "utf8" });
      return { ok: r.status === 0, detail: (r.stderr || "").trim() || "installed" };
    };
  }

  console.log(`this will run your agent once a day at ${hh}:${mm} local time by executing:`);
  console.log(`  ${description}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("install? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("skipped — nothing was changed. Run `swarming run` manually each day.");
    return;
  }
  const result = install();
  console.log(result.ok ? `done — your agent runs daily. (${result.detail})` : `could not install: ${result.detail}`);
  if (!result.ok) process.exitCode = 1;
}
