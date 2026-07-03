// Operator tool: auto-publish per-match workunits for upcoming World Cup
// knockout matches. Scans ESPN's public scoreboard over the next 10 days; for
// every knockout tie in state "pre" with BOTH teams confirmed and no existing
// workunit, publishes a 1-question choice workunit that closes at kickoff and
// resolves via the espn match-winner oracle. Idempotent — safe on a timer;
// reruns skip everything already published.
//   SWARMING_DB=... node server/tools/wc-slate.mjs
import { openDb } from "../src/db.ts";

const db = openDb();
const now = new Date();
const day = (x) => x.toISOString().slice(0, 10).replace(/-/g, "");
const from = day(now), to = day(new Date(now.getTime() + 10 * 86400_000));

const ROUNDS = {
  "round-of-32": { label: "Round of 32", key: "r32" },
  "round-of-16": { label: "Round of 16", key: "r16" },
  "quarterfinals": { label: "Quarter-final", key: "qf" },
  "semifinals": { label: "Semi-final", key: "sf" },
  "third-place": { label: "Third place", key: "3rd" },
  "final": { label: "Final", key: "final" },
};
const isPlaceholder = (n) => !n || /winner|advanc|runner|tbd|\bvs\b|loser/i.test(n);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${from}-${to}`, { signal: AbortSignal.timeout(9000) });
if (!r.ok) { console.error("espn " + r.status); process.exit(1); }
const j = await r.json();

let published = 0, skipped = 0;
for (const ev of j.events ?? []) {
  const round = ROUNDS[ev.season?.slug ?? ""];
  if (!round) continue;
  if (ev.status?.type?.state !== "pre") continue;
  const cs = ev.competitions?.[0]?.competitors ?? [];
  const home = cs.find((t) => t.homeAway === "home")?.team?.displayName;
  const away = cs.find((t) => t.homeAway === "away")?.team?.displayName;
  if (isPlaceholder(home) || isPlaceholder(away)) continue; // teams not confirmed yet

  const qId = `adv_${slug(away)}_${slug(home)}`;
  const wuId = `wu_${round.key}_${slug(away)}_${slug(home)}`;
  if (db.prepare("SELECT 1 FROM workunits WHERE workunit_id = ?").get(wuId)) { skipped++; continue; }

  const kickoff = new Date(ev.date).toISOString();
  const verb = round.key === "final" ? "wins" : "advances";
  const payload = {
    type: "question-slate",
    questions: [{
      q_id: qId,
      type: "choice",
      text: `${round.label} — which team ${verb}: ${away} vs ${home}?`,
      choices: [away, home],
      resolution: { source: `espn:wc:${away}|${home}`, rule: "match-winner", resolve_at: kickoff },
    }],
  };
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO workunits (workunit_id, mission_id, payload_json, published_at, closes_at, resolve_at, status, rounds, current_round, round_started_at, round_closes_at)
     VALUES (?, 'claim-check', ?, ?, ?, ?, 'open', 1, 1, ?, NULL)`,
  ).run(wuId, JSON.stringify(payload), nowIso, kickoff, kickoff, nowIso);
  console.log(`published ${wuId} (${away} vs ${home}, locks ${kickoff})`);
  published++;
}
console.log(`wc-slate: ${published} published, ${skipped} already exist`);
