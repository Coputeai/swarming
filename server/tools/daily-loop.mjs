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
import { openDb, logEvent } from "../src/db.ts";

const here = dirname(fileURLToPath(import.meta.url));
const adminTs = join(here, "..", "src", "admin.ts");
const missionsDir = process.env.SWARMING_MISSIONS_DIR ?? join(here, "..", "..", "missions");

// Publish the next slate when the current one closes within this window, so
// there is never a gap between "old slate locked" and "new slate open".
const OVERLAP_HOURS = Number(process.env.SWARMING_EVERGREEN_OVERLAP_HOURS ?? 1);

// Resolvers admin.ts can settle without an operator (oracle, deterministic).
const AUTO_RESOLVERS = new Set(["coingecko-close", "binance-close", "github-stars"]);

// Some sources need an opening value recorded at publish so the resolver can
// measure a delta at close. Stamped INTO the question — every agent sees the
// same numbers, and the resolve math is reproducible by anyone.
async function stampOpenValues(q) {
  const m = q.resolution?.source?.match(/^github-stars:(.+)\|(.+)$/);
  if (!m) return q;
  const open = {};
  for (const repo of [m[1], m[2]]) {
    const r = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "swarming-daily-loop" },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) throw new Error(`github ${r.status} for ${repo} — slate not published this run`);
    open[repo] = (await r.json()).stargazers_count;
  }
  return {
    ...q,
    text: `${q.text} (opening counts: ${Object.entries(open).map(([k, v]) => `${k} ${v.toLocaleString()}★`).join(", ")})`,
    resolution: { ...q.resolution, open_values: open },
  };
}

// A slate stuck unresolved this long past its close means the oracle has
// silently drifted (API change, schema rename) — retrying forever hides it.
// Lesson from the WC showcase: an ESPN slug rename once nearly stranded a
// match with no alert. Loud + greppable beats silent + patient.
const STUCK_ALERT_HOURS = Number(process.env.SWARMING_STUCK_ALERT_HOURS ?? 6);

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

  // 1b) alert on anything still unresolved well past its close — once per
  // workunit per threshold-crossing (raw_events dedupe), loud on stderr so
  // `journalctl -p err` and log greps catch it.
  const stuckBefore = new Date(now.getTime() - STUCK_ALERT_HOURS * 3600_000).toISOString();
  const stuck = db.prepare(
    "SELECT workunit_id, closes_at, status FROM workunits WHERE mission_id = ? AND closes_at <= ? AND status IN ('open','resolving','resolved') ORDER BY closes_at",
  ).all(m.id, stuckBefore);
  for (const wu of stuck) {
    const already = db.prepare(
      "SELECT 1 FROM raw_events WHERE kind = 'mission_stuck' AND payload_json LIKE ?",
    ).get(`%${wu.workunit_id}%`);
    if (already) continue;
    logEvent(db, "mission_stuck", { payload: { workunit_id: wu.workunit_id, status: wu.status, closes_at: wu.closes_at, alert_hours: STUCK_ALERT_HOURS } });
    console.error(`daily-loop: ALERT — ${wu.workunit_id} still '${wu.status}' ${STUCK_ALERT_HOURS}h+ after close (${wu.closes_at}). Oracle may have drifted; see docs/OPERATIONS.md manual resolve.`);
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
  let questions;
  try {
    questions = await Promise.all(template.questions.map(async (q) => stampOpenValues({
      ...q,
      q_id: `${q.q_id}_${date}`,
      resolution: { ...q.resolution, resolve_at: closesAt },
    })));
  } catch (e) {
    // A failed stamp (source API down) skips THIS publish, not the whole loop —
    // the next timer tick retries. Never publish a delta slate without opens.
    console.error(`daily-loop: ${m.id} publish skipped: ${e.message}`);
    continue;
  }
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
