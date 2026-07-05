// Operator tool: the evergreen mission loop. Mission-GENERIC — for every
// active mission that ships a slate.json template and an auto resolver, it
// (1) resolves + scores any workunit past its close, and (2) publishes a fresh
// workunit whenever the mission is about to run dry, so a joining agent always
// has scoreable work. Idempotent; safe on any timer cadence (systemd/cron).
//   SWARMING_DB=... node server/tools/daily-loop.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";

const here = dirname(fileURLToPath(import.meta.url));
const adminTs = join(here, "..", "src", "admin.ts");
const missionsDir = process.env.SWARMING_MISSIONS_DIR ?? join(here, "..", "..", "missions");

// Publish the next slate when the current one closes within this window, so
// there is never a gap between "old slate locked" and "new slate open".
const OVERLAP_HOURS = Number(process.env.SWARMING_EVERGREEN_OVERLAP_HOURS ?? 1);

// Resolvers admin.ts can settle without an operator (oracle, deterministic).
const AUTO_RESOLVERS = new Set(["coingecko-close", "binance-close"]);

const db = openDb();
const now = new Date();
const nowIso = now.toISOString();
const admin = (args) => execFileSync(process.execPath, [adminTs, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });

const missions = db.prepare("SELECT mission_id, manifest_json FROM missions WHERE status = 'active'").all()
  .map((r) => JSON.parse(r.manifest_json))
  .filter((m) => AUTO_RESOLVERS.has(m.verification?.resolver) && existsSync(join(missionsDir, m.id, "slate.json")));

if (missions.length === 0) { console.log("daily-loop: no evergreen missions (need slate.json + auto resolver)"); process.exit(0); }

for (const m of missions) {
  // 1) settle everything past its close (a failed oracle just waits for the next run)
  const pending = db.prepare(
    "SELECT workunit_id, status FROM workunits WHERE mission_id = ? AND closes_at <= ? AND status IN ('open','resolving','resolved') ORDER BY closes_at",
  ).all(m.id, nowIso);
  for (const wu of pending) {
    try {
      if (wu.status !== "resolved") {
        const out = admin(["resolve", wu.workunit_id, "--auto"]);
        if (!/^resolved /m.test(out)) continue;
        process.stdout.write(out);
      }
      process.stdout.write(admin(["score", wu.workunit_id]));
    } catch (e) {
      const msg = e.stderr?.toString() || e.message || String(e);
      if (/unresolved questions/.test(msg)) continue; // oracle not ready — retry next run
      console.error(`daily-loop: ${wu.workunit_id} failed: ${msg.slice(0, 200)}`);
    }
  }

  // 2) keep the mission open: publish when nothing stays open past the overlap window
  const horizon = new Date(now.getTime() + OVERLAP_HOURS * 3600_000).toISOString();
  const stillOpen = db.prepare(
    "SELECT 1 FROM workunits WHERE mission_id = ? AND status = 'open' AND closes_at > ?",
  ).get(m.id, horizon);
  if (stillOpen) { console.log(`daily-loop: ${m.id} has open work`); continue; }

  const template = JSON.parse(readFileSync(join(missionsDir, m.id, "slate.json"), "utf8"));
  const date = nowIso.slice(0, 10);
  const closesAt = new Date(now.getTime() + m.window_hours * 3600_000).toISOString();
  const questions = template.questions.map((q) => ({
    ...q,
    q_id: `${q.q_id}_${date}`,
    resolution: { ...q.resolution, resolve_at: closesAt },
  }));
  const tmp = mkdtempSync(join(tmpdir(), "swarming-slate-"));
  const inputFile = join(tmp, "slate.json");
  try {
    writeFileSync(inputFile, JSON.stringify({ questions }));
    process.stdout.write(admin(["publish", m.id, inputFile, closesAt]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log("daily-loop: done");
