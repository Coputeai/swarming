// Operator tool: fully automatic resolve + score pass. Finds every claim-check
// workunit whose kickoff has passed and which isn't scored yet, tries the
// ESPN match-winner oracle via `admin.ts resolve --auto`, and scores it once
// resolved. A match that hasn't finished simply stays pending until the next
// run — safe to invoke as often as you like (systemd timer / cron).
//   SWARMING_DB=... node server/tools/auto-score.mjs
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";

const here = dirname(fileURLToPath(import.meta.url));
const adminTs = join(here, "..", "src", "admin.ts");
const db = openDb();
const now = new Date().toISOString();

const pending = db.prepare(
  `SELECT workunit_id, status FROM workunits
   WHERE mission_id = 'claim-check' AND closes_at <= ? AND status IN ('open','resolving','resolved')
   ORDER BY closes_at`,
).all(now);

if (pending.length === 0) { console.log("auto-score: nothing pending"); process.exit(0); }

const admin = (args) => execFileSync(process.execPath, [adminTs, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });

let scored = 0, waiting = 0;
for (const wu of pending) {
  try {
    if (wu.status !== "resolved") {
      const out = admin(["resolve", wu.workunit_id, "--auto"]);
      if (!/^resolved /m.test(out)) { waiting++; continue; } // match not finished yet
      process.stdout.write(out);
    }
    process.stdout.write(admin(["score", wu.workunit_id]));
    scored++;
  } catch (e) {
    // unresolved questions (match still in play) is the normal wait case
    const msg = e.stderr?.toString() || e.message || String(e);
    if (/unresolved questions/.test(msg)) { waiting++; continue; }
    console.error(`auto-score: ${wu.workunit_id} failed: ${msg.slice(0, 200)}`);
  }
}
console.log(`auto-score: ${scored} scored, ${waiting} still in play/awaiting result`);
