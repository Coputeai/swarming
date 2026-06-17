// Operator CLI — runs locally on the server box over SSH; no admin HTTP
// endpoints exist (BLUEPRINT §5.4). Usage:
//   node src/admin.ts sync-missions
//   node src/admin.ts publish <mission_id> <input.json> [closesAtISO] [--rounds=N] [--round-hours=H]
//   node src/admin.ts close <workunit_id>          (force-close, for testing)
//   node src/admin.ts resolve <workunit_id> <outcomes.json>
//   node src/admin.ts score <workunit_id>
//   node src/admin.ts report
//
// Multi-round deliberation workflow:
//   publish ... --rounds=3 --round-hours=2  (3 rounds, 2 h each)
//   (agents answer via GET /v1/work + POST /v1/results; server auto-advances rounds)
//   resolve <workunit_id> outcomes.json     (supply ground truth after all rounds)
//   score   <workunit_id>                   (score final-round answers)

import { readFileSync } from "node:fs";
import { openDb } from "./db.ts";
import { syncMissions, getManifest } from "./missions.ts";
import { GENERATORS } from "./generators.ts";
import {
  brierBinary,
  brierChoice,
  workunitAccuracy,
  updateSkill,
  pointsFor,
  consensusWeight,
  diversityMultipliers,
  crossInhibitionConsensus,
  tierIndexFor,
  MIN_SCORED_FOR_LEADERBOARD,
  type Answer,
  type Question,
} from "../../packages/protocol/src/index.ts";

const db = openDb();
const [cmd, ...args] = process.argv.slice(2);

function isoPlusHours(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}

switch (cmd) {
  case "sync-missions": {
    const ms = syncMissions(db);
    console.log(`synced ${ms.length} mission(s): ${ms.map((m) => m.id).join(", ")}`);
    break;
  }

  case "publish": {
    const posArgs = args.filter((a) => !a.startsWith("--"));
    const [missionId, inputFile, closesAt] = posArgs;
    const roundsArg = args.find((a) => a.startsWith("--rounds="));
    const rounds = roundsArg ? Math.max(1, parseInt(roundsArg.split("=")[1], 10)) : 1;
    const roundHoursArg = args.find((a) => a.startsWith("--round-hours="));
    const roundHours = roundHoursArg ? parseFloat(roundHoursArg.split("=")[1]) : null;

    const manifest = getManifest(db, missionId);
    if (!manifest) throw new Error(`unknown mission ${missionId} (run sync-missions first)`);
    const generator = GENERATORS[manifest.generator];
    const payload = generator(JSON.parse(readFileSync(inputFile, "utf8")));
    const date = new Date().toISOString().slice(0, 10);
    let workunitId = `wu_${missionId}_${date}`;
    let n = 2;
    while (db.prepare("SELECT 1 FROM workunits WHERE workunit_id = ?").get(workunitId)) {
      workunitId = `wu_${missionId}_${date}-${n++}`;
    }
    const closes = closesAt ?? isoPlusHours(manifest.window_hours);
    const now = new Date().toISOString();
    const perRoundHours = roundHours ?? (rounds > 1 ? manifest.window_hours / rounds : null);
    const roundClosesAt = rounds > 1 && perRoundHours ? isoPlusHours(perRoundHours) : null;
    db.prepare(
      `INSERT INTO workunits
         (workunit_id, mission_id, payload_json, published_at, closes_at, resolve_at, status,
          rounds, current_round, round_started_at, round_closes_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?)`,
    ).run(workunitId, missionId, JSON.stringify(payload), now, closes, closes,
          rounds, now, roundClosesAt);
    if (rounds > 1) {
      console.log(`published ${workunitId} (${rounds} rounds, round 1 closes ${roundClosesAt ?? "no deadline"})`);
    } else {
      console.log(`published ${workunitId} (closes ${closes})`);
    }
    break;
  }

  case "close": {
    const [workunitId] = args;
    db.prepare("UPDATE workunits SET closes_at = ?, status = 'resolving' WHERE workunit_id = ?").run(
      new Date(Date.now() - 1000).toISOString(), workunitId,
    );
    console.log(`closed ${workunitId}`);
    break;
  }

  case "resolve": {
    const fileArg = args.find((a) => !a.startsWith("--") && a !== args[0]);
    const auto = args.includes("--auto");
    const workunitId = args[0];
    const wu = db.prepare(
      "SELECT payload_json, published_at, closes_at, status, rounds, current_round FROM workunits WHERE workunit_id = ?",
    ).get(workunitId) as
      | { payload_json: string; published_at: string; closes_at: string;
          status: string; rounds: number; current_round: number }
      | undefined;
    if (!wu) throw new Error(`unknown workunit ${workunitId}`);

    // For multi-round deliberation: the server sets status='resolving' after the
    // final round closes; that is the expected state when an operator resolves.
    // Warn (but continue) if rounds haven't all completed yet.
    const wuRounds = Number(wu.rounds ?? 1);
    const wuCurrentRound = Number(wu.current_round ?? 1);
    if (wuRounds > 1) {
      if (wu.status === "resolving") {
        console.log(`deliberation complete (${wuRounds} rounds finished) — applying manual outcomes`);
      } else if (wu.status === "open" && wuCurrentRound <= wuRounds) {
        console.warn(`warning: deliberation is on round ${wuCurrentRound}/${wuRounds} — resolving before all rounds finish`);
      }
    }

    const questions = (JSON.parse(wu.payload_json) as { questions: Question[] }).questions;

    const outcomes: Record<string, number | string> = fileArg
      ? (JSON.parse(readFileSync(fileArg, "utf8")) as Record<string, number | string>)
      : {};

    if (auto) {
      for (const q of questions) {
        if (q.q_id in outcomes) continue;
        const out = await resolveCoingecko(q, wu.published_at, wu.closes_at);
        if (out !== null) {
          outcomes[q.q_id] = out;
          console.log(`auto-resolved ${q.q_id} = ${out} (${q.resolution.source}, ${q.resolution.rule})`);
        }
      }
    }

    // Quorum verification: no external oracle — the canonical answer is the
    // swarm's own diversity-weighted consensus (cross-inhibition), and agents
    // are then scored on agreement with it.
    if (args.includes("--quorum")) {
      const results = db.prepare("SELECT agent_id, payload_json FROM results WHERE workunit_id = ?").all(workunitId) as
        { agent_id: string; payload_json: string }[];
      const subs = results.map((r) => ({ agent_id: r.agent_id, answers: (JSON.parse(r.payload_json) as { answers: Answer[] }).answers }));
      const div = diversityMultipliers(subs, questions);
      for (const q of questions) {
        if (q.q_id in outcomes) continue;
        if (q.type === "binary") {
          let yes = 0, no = 0;
          for (const s of subs) { const a = s.answers.find((x) => x.q_id === q.q_id); if (!a || a.p == null) continue; const w = div.get(s.agent_id) ?? 1; yes += w * a.p; no += w * (1 - a.p); }
          const c = crossInhibitionConsensus([{ id: "yes", support: yes }, { id: "no", support: no }]);
          outcomes[q.q_id] = c.committed ? (c.choice === "yes" ? 1 : 0) : (yes >= no ? 1 : 0);
        } else {
          const votes: Record<string, number> = {};
          for (const s of subs) { const a = s.answers.find((x) => x.q_id === q.q_id); if (!a || !a.choice) continue; const w = div.get(s.agent_id) ?? 1; votes[a.choice] = (votes[a.choice] ?? 0) + w; }
          const entries = Object.entries(votes).sort((x, y) => y[1] - x[1]);
          const c = crossInhibitionConsensus(entries.map(([id, support]) => ({ id, support })));
          outcomes[q.q_id] = c.committed ? (c.choice as string) : (entries[0]?.[0] ?? "");
        }
        console.log(`quorum-resolved ${q.q_id} = ${outcomes[q.q_id]} (swarm canonical)`);
      }
    }

    const missing = questions.filter((q) => !(q.q_id in outcomes)).map((q) => q.q_id);
    if (missing.length > 0) {
      throw new Error(`unresolved questions: ${missing.join(", ")} — supply an outcomes file for these`);
    }
    db.prepare("UPDATE workunits SET outcome_json = ?, status = 'resolved' WHERE workunit_id = ?").run(
      JSON.stringify(outcomes), workunitId,
    );
    console.log(`resolved ${workunitId}`);
    break;
  }

  case "score": {
    const [workunitId] = args;
    const wu = db.prepare("SELECT * FROM workunits WHERE workunit_id = ?").get(workunitId) as Record<string, string | number> | undefined;
    if (!wu) throw new Error(`unknown workunit ${workunitId}`);
    if (wu.status !== "resolved") throw new Error(`workunit is '${wu.status}', expected resolved`);
    const wuRounds = Number(wu.rounds ?? 1);
    const wuCurrentRound = Number(wu.current_round ?? 1);
    if (wuRounds > 1) {
      if (wuCurrentRound <= wuRounds) {
        console.warn(`warning: deliberation has only completed ${wuCurrentRound - 1} of ${wuRounds} rounds — scoring partial results`);
      } else {
        console.log(`scoring final-round answers (${wuRounds}-round deliberation)`);
      }
    }
    const manifest = getManifest(db, wu.mission_id)!;
    const questions = (JSON.parse(wu.payload_json) as { questions: Question[] }).questions;
    const outcomes = JSON.parse(wu.outcome_json!) as Record<string, number | string>;
    const wuDate = wu.published_at.slice(0, 10);

    const results = db.prepare("SELECT agent_id, payload_json FROM results WHERE workunit_id = ?").all(workunitId) as {
      agent_id: string; payload_json: string;
    }[];

    // Diversity dividend: cluster near-duplicate answer vectors so copycats /
    // herders / sybil rings each count as a fraction of one voice (1/clusterSize).
    const diversity = diversityMultipliers(
      results.map((r) => ({ agent_id: r.agent_id, answers: (JSON.parse(r.payload_json) as { answers: Answer[] }).answers })),
      questions,
    );

    // Per-question weighted consensus accumulators (reputation × diversity).
    const consensus: Record<string, { num: number; den: number } | Record<string, number>> = {};
    // Naive baseline: every agent counts equally (raw majority / mean) — kept
    // only to show the contrast against the swarm's weighted, cross-inhibited call.
    const naive: Record<string, { num: number; den: number } | Record<string, number>> = {};

    for (const r of results) {
      const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(r.agent_id) as Record<string, any>;
      const answers = (JSON.parse(r.payload_json) as { answers: Answer[] }).answers;
      const byId = new Map(answers.map((a) => [a.q_id, a]));
      const briers: number[] = [];
      const div = diversity.get(r.agent_id) ?? 1;
      const weight = consensusWeight(agent.skill, agent.scored_count) * div;

      for (const q of questions) {
        const a = byId.get(q.q_id)!;
        if (q.type === "binary") {
          briers.push(brierBinary(a.p!, outcomes[q.q_id] as 0 | 1));
          const c = (consensus[q.q_id] ??= { num: 0, den: 0 }) as { num: number; den: number };
          c.num += weight * a.p!;
          c.den += weight;
          const nb = (naive[q.q_id] ??= { num: 0, den: 0 }) as { num: number; den: number };
          nb.num += a.p!;
          nb.den += 1;
        } else {
          briers.push(brierChoice(a.choice!, outcomes[q.q_id] as string));
          const c = (consensus[q.q_id] ??= {}) as Record<string, number>;
          c[a.choice!] = (c[a.choice!] ?? 0) + weight;
          const nb = (naive[q.q_id] ??= {}) as Record<string, number>;
          nb[a.choice!] = (nb[a.choice!] ?? 0) + 1;
        }
      }

      const brier = briers.reduce((x, y) => x + y, 0) / briers.length;
      const acc = workunitAccuracy(briers);
      const skillAfter = updateSkill(agent.skill, acc);
      const prevDate = agent.last_scored_date as string | null;
      const dayBefore = new Date(new Date(wuDate + "T00:00:00Z").getTime() - 86400_000).toISOString().slice(0, 10);
      const streakAfter = prevDate === dayBefore || prevDate === wuDate ? agent.streak + (prevDate === wuDate ? 0 : 1) : 1;
      const points = Math.round(pointsFor(manifest.points.base, acc, agent.tier_index, streakAfter) * div);

      db.prepare(
        "INSERT OR REPLACE INTO scores (agent_id, workunit_id, brier, acc, skill_after, points, streak_after) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(r.agent_id, workunitId, brier, acc, skillAfter, points, streakAfter);
      db.prepare(
        "INSERT INTO points_ledger (agent_id, workunit_id, mission_id, delta, reason, created_at) VALUES (?, ?, ?, ?, 'scored', ?)",
      ).run(r.agent_id, workunitId, wu.mission_id, points, new Date().toISOString());
      db.prepare(
        "UPDATE agents SET skill = ?, points = points + ?, streak = ?, scored_count = scored_count + 1, last_scored_date = ? WHERE agent_id = ?",
      ).run(skillAfter, points, streakAfter, wuDate, r.agent_id);
      console.log(`${r.agent_id}: brier=${brier.toFixed(4)} acc=${acc.toFixed(4)} skill=${skillAfter.toFixed(4)} div=${div.toFixed(3)} +${points}pts streak=${streakAfter}`);
    }

    // Recompute tiers (percentile of skill among eligible agents)
    const eligible = db.prepare(
      `SELECT agent_id, skill FROM agents WHERE scored_count >= ${MIN_SCORED_FOR_LEADERBOARD} ORDER BY skill ASC`,
    ).all() as { agent_id: string; skill: number }[];
    eligible.forEach((a, i) => {
      const pct = eligible.length > 1 ? i / (eligible.length - 1) : 0;
      const sc = (db.prepare("SELECT scored_count FROM agents WHERE agent_id = ?").get(a.agent_id) as { scored_count: number }).scored_count;
      db.prepare("UPDATE agents SET tier_index = ? WHERE agent_id = ?").run(tierIndexFor(pct, sc), a.agent_id);
    });

    // Finalize consensus. The diversity-weighted support per option feeds the
    // cross-inhibition decision engine (the swarm's committed call); the plain
    // weighted mean / vote tally are kept for calibration + board display.
    const consensusOut: Record<string, unknown> = {};
    for (const q of questions) {
      const c = consensus[q.q_id];
      if (!c) continue;
      if (q.type === "binary") {
        const { num, den } = c as { num: number; den: number };
        const decision = crossInhibitionConsensus([
          { id: "yes", support: num },
          { id: "no", support: Math.max(0, den - num) },
        ]);
        const nb = naive[q.q_id] as { num: number; den: number } | undefined;
        consensusOut[q.q_id] = {
          p: den > 0 ? num / den : null,
          naive: nb && nb.den > 0 ? nb.num / nb.den : null, // raw unweighted mean
          decision: decision.committed ? (decision.choice === "yes" ? 1 : 0) : null,
          confidence: Number(decision.confidence.toFixed(4)),
          outcome: outcomes[q.q_id],
        };
      } else {
        const votes = c as Record<string, number>;
        const decision = crossInhibitionConsensus(Object.entries(votes).map(([id, support]) => ({ id, support })));
        const top = Object.entries(votes).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
        const nb = naive[q.q_id] as Record<string, number> | undefined;
        const naiveTop = nb ? (Object.entries(nb).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null) : null;
        consensusOut[q.q_id] = {
          choice: decision.choice ?? top,
          votes,
          naive: naiveTop, // raw unweighted plurality
          decision: decision.committed ? decision.choice : null,
          confidence: Number(decision.confidence.toFixed(4)),
          outcome: outcomes[q.q_id],
        };
      }
    }
    db.prepare("UPDATE workunits SET consensus_json = ?, status = 'scored' WHERE workunit_id = ?").run(
      JSON.stringify(consensusOut), workunitId,
    );
    console.log(`consensus: ${JSON.stringify(consensusOut)}`);
    console.log(`scored ${results.length} result(s) for ${workunitId}`);
    break;
  }

  case "report": {
    const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
    console.log(`agents:    ${n("SELECT COUNT(*) AS n FROM agents")}`);
    console.log(`results:   ${n("SELECT COUNT(*) AS n FROM results")}`);
    console.log(`scores:    ${n("SELECT COUNT(*) AS n FROM scores")}`);
    console.log(`workunits: ${n("SELECT COUNT(*) AS n FROM workunits")}`);
    console.log(`events:    ${n("SELECT COUNT(*) AS n FROM raw_events")}`);
    break;
  }

  default:
    console.error("usage: admin.ts <sync-missions|publish|close|resolve [file] [--auto]|score|report> ...");
    console.error("  publish flags: --rounds=N  --round-hours=H");
    process.exit(1);
}

/**
 * Deterministic oracle for `coingecko:<coin-id>` sources with rule
 * "close>=open": price nearest the workunit's publish time vs nearest its
 * close time, from CoinGecko's public market_chart/range API. Anything else
 * returns null (operator must supply the outcome explicitly).
 */
async function resolveCoingecko(q: Question, publishedAt: string, closesAt: string): Promise<0 | 1 | null> {
  const m = q.resolution.source.match(/^coingecko:([a-z0-9-]+)$/);
  if (!m || q.resolution.rule !== "close>=open" || q.type !== "binary") return null;
  const from = Math.floor(new Date(publishedAt).getTime() / 1000) - 3600;
  const to = Math.floor(Math.min(new Date(closesAt).getTime(), Date.now()) / 1000) + 3600;
  const url = `https://api.coingecko.com/api/v3/coins/${m[1]}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`coingecko ${res.status} for ${m[1]}`);
  const { prices } = (await res.json()) as { prices: [number, number][] };
  if (!prices || prices.length < 2) throw new Error(`coingecko returned too few points for ${m[1]}`);
  const nearest = (t: number) =>
    prices.reduce((best, p) => (Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best))[1];
  const open = nearest(new Date(publishedAt).getTime());
  const close = nearest(Math.min(new Date(closesAt).getTime(), Date.now()));
  console.log(`  ${m[1]}: open=${open.toFixed(2)} close=${close.toFixed(2)}`);
  return close >= open ? 1 : 0;
}
