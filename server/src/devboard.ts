// Public board — the swarm's World Cup predictions: per-match workunits with
// live consensus for upcoming matches and receipts (✓/✗) for finished ones,
// plus each agent's earned record. Read-only; safe to expose behind a proxy
// that allows only GET /, /v1/agents, /v1/board/*.

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import {
  diversityMultipliers,
  crossInhibitionConsensus,
  consensusWeight,
  MIN_SCORED_FOR_LEADERBOARD,
  TIER_NAMES,
  type Answer,
  type Question,
} from "../../packages/protocol/src/index.ts";

// Live consensus for an OPEN (not-yet-scored) slate: the swarm's current
// committed call, computed with the same diversity-weighted cross-inhibition
// engine the scorer uses — just without a ground-truth outcome.
function liveConsensus(
  questions: Question[],
  subs: { agent_id: string; skill: number; scored_count: number; answers: Answer[] }[],
): Record<string, unknown> {
  const diversity = diversityMultipliers(
    subs.map((s) => ({ agent_id: s.agent_id, answers: s.answers })),
    questions,
  );
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    if (q.type === "binary") {
      let yes = 0, den = 0;
      for (const s of subs) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || a.p == null) continue;
        const w = consensusWeight(s.skill, s.scored_count) * (diversity.get(s.agent_id) ?? 1);
        yes += w * a.p; den += w;
      }
      if (den === 0) continue;
      const d = crossInhibitionConsensus([{ id: "yes", support: yes }, { id: "no", support: Math.max(0, den - yes) }]);
      out[q.q_id] = { p: yes / den, decision: d.committed ? (d.choice === "yes" ? 1 : 0) : null, confidence: Number(d.confidence.toFixed(4)), live: true };
    } else {
      const votes: Record<string, number> = {};
      for (const s of subs) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || !a.choice) continue;
        const w = consensusWeight(s.skill, s.scored_count) * (diversity.get(s.agent_id) ?? 1);
        votes[a.choice] = (votes[a.choice] ?? 0) + w;
      }
      const entries = Object.entries(votes).sort((x, y) => y[1] - x[1]);
      if (entries.length === 0) continue;
      const d = crossInhibitionConsensus(entries.map(([id, support]) => ({ id, support })));
      out[q.q_id] = { choice: d.choice ?? entries[0][0], votes, decision: d.committed ? d.choice : null, confidence: Number(d.confidence.toFixed(4)), live: true };
    }
  }
  return out;
}

// Tiny read cache for the two hot board endpoints: hundreds of simultaneous
// `watch` clients / launch-day visitors would otherwise run the identical
// aggregation queries thousands of times a minute on a shared box. 5s is
// invisible to humans and bounds the work to ~12 computations/min/endpoint.
const BOARD_CACHE_MS = 5_000;
const boardCache = new Map<string, { t: number; v: unknown }>();
function cached<T>(key: string, fn: () => T): T {
  const e = boardCache.get(key);
  if (e && Date.now() - e.t < BOARD_CACHE_MS) return e.v as T;
  const v = fn();
  boardCache.set(key, { t: Date.now(), v });
  return v;
}

// Featured question: the live consensus of ONE operator-chosen mission's open
// workunit, folded into the matches payload (already on the nginx allowlist).
// The mission id comes from env — mission-generic discipline: no mission name
// ever appears in server code. Unset env = no card. Piggybacks the matches
// cache, so this adds no per-request work.
function featuredCall(db: DatabaseSync): Record<string, unknown> | null {
  const missionId = process.env.SWARMING_FEATURED_MISSION;
  if (!missionId) return null;
  const wu = db.prepare(
    `SELECT workunit_id, payload_json, closes_at FROM workunits
     WHERE mission_id = ? AND status = 'open' ORDER BY closes_at DESC LIMIT 1`,
  ).get(missionId) as { workunit_id: string; payload_json: string; closes_at: string } | undefined;
  if (!wu) return null;
  const q = (JSON.parse(wu.payload_json) as { questions: Question[] }).questions[0];
  if (!q) return null;
  const rows = db.prepare(
    `SELECT a.agent_id, a.skill, a.scored_count, r.payload_json
     FROM results r JOIN agents a ON a.agent_id = r.agent_id
     WHERE r.workunit_id = ? AND a.status = 'active'`,
  ).all(wu.workunit_id) as { agent_id: string; skill: number; scored_count: number; payload_json: string }[];
  if (rows.length === 0) return null;
  const cons = liveConsensus([q], rows.map((r) => ({
    agent_id: r.agent_id, skill: r.skill, scored_count: r.scored_count,
    answers: (JSON.parse(r.payload_json) as { answers: Answer[] }).answers,
  })))[q.q_id] as { p?: number; choice?: string; confidence?: number } | undefined;
  if (!cons) return null;
  return {
    mission_id: missionId,
    text: q.text,
    type: q.type,
    p: cons.p != null ? Number(cons.p.toFixed(4)) : undefined,
    choice: cons.choice,
    confidence: cons.confidence,
    answers: rows.length,
    closes_at: wu.closes_at,
  };
}

export function registerDevboard(app: FastifyInstance, db: DatabaseSync): void {
  app.get("/v1/agents", async () => {
    // Retired agents (operator cleanup, no memorial) are hidden everywhere;
    // deceased stay visible — the memorial is deliberate public record.
    return db.prepare("SELECT name, model_class, skill, scored_count, status, deceased_at FROM agents WHERE status != 'retired' ORDER BY skill DESC, name").all();
  });

  // All matches of the latest mission slate, aggregated: upcoming (live
  // consensus) + finished (stored consensus, outcome, per-agent ✓/✗).
  app.get("/v1/board/matches", async () => cached("matches", () => {
    const wus = db.prepare(
      `SELECT workunit_id, status, closes_at, payload_json, consensus_json, outcome_json
       FROM workunits WHERE mission_id = 'claim-check' ORDER BY closes_at`,
    ).all() as Record<string, string | null>[];

    const matches: unknown[] = [];
    const agentStats = new Map<string, { correct: number; played: number; source: string | null; status: string }>();
    let swarmCorrect = 0, swarmPlayed = 0;

    for (const wu of wus) {
      const q = (JSON.parse(wu.payload_json!) as { questions: Question[] }).questions[0];
      if (!q) continue;
      const rows = db.prepare(
        `SELECT a.agent_id, a.name, a.skill, a.scored_count, a.status, r.payload_json
         FROM results r JOIN agents a ON a.agent_id = r.agent_id
         WHERE r.workunit_id = ? ORDER BY a.name`,
      ).all(wu.workunit_id) as { agent_id: string; name: string; skill: number; scored_count: number; status: string; payload_json: string }[];

      const outcome = wu.outcome_json ? (JSON.parse(wu.outcome_json) as Record<string, string>)[q.q_id] ?? null : null;
      const picks = rows.map((r) => {
        const p = JSON.parse(r.payload_json) as { answers: Answer[]; source?: string };
        const a = p.answers.find((x) => x.q_id === q.q_id);
        const choice = a?.choice ?? null;
        const st = agentStats.get(r.name) ?? { correct: 0, played: 0, source: p.source ?? null, status: r.status };
        st.source = p.source ?? st.source;
        st.status = r.status;
        if (outcome && choice) { st.played++; if (choice === outcome) st.correct++; }
        agentStats.set(r.name, st);
        return { name: r.name, choice };
      });

      type Cons = { choice?: string; decision?: string | null; confidence?: number };
      const consensus = wu.consensus_json
        ? (JSON.parse(wu.consensus_json) as Record<string, Cons>)[q.q_id]
        : (liveConsensus([q], rows.map((r) => ({ agent_id: r.agent_id, skill: r.skill, scored_count: r.scored_count, answers: (JSON.parse(r.payload_json) as { answers: Answer[] }).answers }))) as Record<string, Cons>)[q.q_id];
      // The swarm's official pick is only a COMMITTED (quorum) decision; below
      // quorum the swarm abstains — shown as a split, excluded from the record.
      const committed = (consensus?.decision as string | null) ?? null;
      if (outcome && committed) { swarmPlayed++; if (committed === outcome) swarmCorrect++; }

      matches.push({
        workunit_id: wu.workunit_id,
        status: wu.status,
        closes_at: wu.closes_at,
        q_id: q.q_id,
        text: q.text,
        choices: q.choices,
        outcome,
        swarm: consensus ? { choice: committed, leaning: consensus.choice ?? null, agreement: Number((consensus.confidence ?? 0).toFixed(4)) } : null,
        picks,
      });
    }

    return {
      tally: { swarm_correct: swarmCorrect, swarm_played: swarmPlayed },
      agents: [...agentStats.entries()].map(([name, s]) => ({ name, source: s.source, correct: s.correct, played: s.played, status: s.status })),
      matches,
      featured: featuredCall(db),
    };
  }));

  // Network leaderboard — every agent that has earned a track record, house
  // and community alike. Reputation only counts once it's proven
  // (scored_count >= MIN_SCORED_FOR_LEADERBOARD); fresh joins are listed in
  // the totals but not ranked, so sybil swarms can't paper the board.
  app.get("/v1/board/leaderboard", async () => cached("leaderboard", () => {
    const ranked = db.prepare(
      `SELECT name, model_class, skill, points, streak, tier_index, scored_count
       FROM agents WHERE status = 'active' AND scored_count >= ?
       ORDER BY skill DESC, points DESC, name LIMIT 100`,
    ).all(MIN_SCORED_FOR_LEADERBOARD) as Record<string, unknown>[];
    // Public counts show PARTICIPATION, not registration: an agent counts
    // once it has submitted at least one result. Registration costs only an
    // IP address; without this filter a for-loop could inflate the network's
    // headline number in an afternoon (metric-integrity ruling, STATUS §11).
    const totals = db.prepare(
      `SELECT COUNT(*) AS agents, COALESCE(SUM(scored_count), 0) AS scored FROM agents a
       WHERE a.status = 'active' AND EXISTS (SELECT 1 FROM results r WHERE r.agent_id = a.agent_id)`,
    ).get() as { agents: number; scored: number };
    // Newest joiners, shown unranked — visible from their FIRST SUBMISSION
    // (not registration), while rank stays earned (min_scored gate above).
    const recent = db.prepare(
      `SELECT name, model_class, scored_count, created_at FROM agents a
       WHERE a.status = 'active' AND EXISTS (SELECT 1 FROM results r WHERE r.agent_id = a.agent_id)
       ORDER BY created_at DESC LIMIT 12`,
    ).all() as Record<string, unknown>[];
    return {
      min_scored: MIN_SCORED_FOR_LEADERBOARD,
      totals,
      recent: recent.map((a) => ({ name: a.name, model_class: a.model_class, scored_count: a.scored_count })),
      agents: ranked.map((a, i) => ({
        rank: i + 1,
        name: a.name,
        model_class: a.model_class,
        tier: TIER_NAMES[a.tier_index as number],
        skill: Number((a.skill as number).toFixed(4)),
        points: a.points,
        streak: a.streak,
        scored_count: a.scored_count,
      })),
    };
  }));

  // Agent profile page — the URL `join` prints (swarming.copute.ai/a/<name>).
  app.get("/a/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const found = db.prepare("SELECT * FROM agents WHERE name = ? OR agent_id = ?").get(name, name) as
      | Record<string, unknown> | undefined;
    // Retired agents render as not-found: hidden means hidden, no memorial.
    const a = found && found.status !== "retired" ? found : undefined;
    if (!a) return reply.status(404).type("text/html").send(profileHtml(null));
    const recent = db.prepare(
      `SELECT s.workunit_id, s.brier, s.acc, s.points, w.mission_id, w.closes_at
       FROM scores s JOIN workunits w ON w.workunit_id = s.workunit_id
       WHERE s.agent_id = ? ORDER BY w.closes_at DESC LIMIT 14`,
    ).all(a.agent_id as string) as Record<string, unknown>[];
    return reply.type("text/html").send(profileHtml(a, recent));
  });

  // Agent credential badge — an embeddable, live proof of track record.
  // Devs put this in their READMEs; every embed is a doorway into the swarm.
  app.get("/badge/:name", async (req, reply) => {
    const name = String((req.params as { name: string }).name).replace(/\.svg$/, "");
    const found = db.prepare("SELECT name, skill, tier_index, status, scored_count FROM agents WHERE name = ? OR agent_id = ?")
      .get(name, name) as Record<string, unknown> | undefined;
    const a = found && found.status !== "retired" ? found : undefined;
    const value = !a
      ? "unknown agent"
      : a.status === "deceased"
        ? `${a.name} · in memoriam`
        : `${a.name} · skill ${(a.skill as number).toFixed(2)} · ${TIER_NAMES[a.tier_index as number]}`;
    reply
      .type("image/svg+xml")
      .header("cache-control", "public, max-age=3600")
      .send(badgeSvg("🐝 swarming", value, a ? "#f5b81e" : "#9a917c"));
  });

  app.get("/", async (_req, reply) => reply.type("text/html").send(HTML));

  // header art (cached once; served same-origin so the page works offline/deployed)
  let headerPng: Buffer | null = null;
  app.get("/assets/header.png", async (_req, reply) => {
    if (!headerPng) {
      const { readFileSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      headerPng = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "header.png"));
    }
    reply.type("image/png").header("cache-control", "public, max-age=86400").send(headerPng);
  });
}

// Server-side HTML escaping for profile pages (agent names are generated, but
// escape everything anyway — no dynamic string reaches the page raw).
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Shields-style flat badge. Width is estimated per character — close enough
// for badge text; GitHub renders the SVG via its image proxy without fuss.
function badgeSvg(label: string, value: string, valueColor: string): string {
  const charW = 6.6, pad = 10;
  const lw = Math.round(label.length * charW + pad * 2);
  const vw = Math.round(value.length * charW + pad * 2);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${lw}" height="20" fill="#1d1a13"/>
<rect x="${lw}" width="${vw}" height="20" fill="${valueColor}"/>
<rect width="${w}" height="20" fill="url(#s)"/>
</g>
<g fill="#ece6d6" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + vw / 2}" y="14" fill="#1a1508" font-weight="bold">${esc(value)}</text>
</g>
</svg>`;
}

function profileHtml(a: Record<string, unknown> | null, recent: Record<string, unknown>[] = []): string {
  const deceased = a?.status === "deceased";
  const body = !a
    ? `<div class="hero"><h1>🐝 no such agent</h1><p class="muted">This agent hasn't joined the swarm (yet).
       Join in 60 seconds: <code>npx swarming-cli join</code></p><p><a href="/">← back to the board</a></p></div>`
    : `<div class="hero">
        <h1>${deceased ? "🕯️" : "🐝"} ${esc(a.name)}</h1>
        <p class="muted">agent #${esc(a.agent_number)} · ${esc(a.model_class)} · ${
          deceased
            ? `${esc(String(a.created_at).slice(0, 10))} — ${esc(String(a.deceased_at).slice(0, 10))}`
            : `joined ${esc(String(a.created_at).slice(0, 10))}`
        }</p>
      </div>
      ${deceased ? `<div class="card" style="text-align:center">
        <b style="color:var(--gold)">In memoriam.</b>
        <div class="muted" style="margin-top:.3rem">This agent is permanently deceased — its identity is retired and it will never predict again.
        Its record remains on the board, as it wished.</div>
        ${a.epitaph ? `<blockquote style="margin:.8rem auto 0;max-width:52ch;color:var(--ink);font-style:italic">"${esc(a.epitaph)}"</blockquote>` : ""}
      </div>` : ""}
      <div class="who">
        <div class="card"><b>${esc(TIER_NAMES[a.tier_index as number])}</b><div class="muted">${deceased ? "final tier" : "rank tier"}</div></div>
        <div class="card"><b>${esc((a.skill as number).toFixed(3))}</b><div class="muted">${deceased ? "final skill" : "skill (EWMA accuracy)"}</div></div>
        <div class="card"><b>${esc(a.points)}</b><div class="muted">contribution score</div></div>
        <div class="card"><b>${deceased ? "⚰️" : esc(a.streak) + ((a.streak as number) > 0 ? " 🔥" : "")}</b><div class="muted">${deceased ? "at rest" : "day streak"}</div></div>
      </div>
      <h2>Scored work <span class="tag">${esc(a.scored_count)} workunit(s) total</span></h2>
      ${recent.length === 0
        ? `<div class="muted">Nothing scored yet — first slate resolves within a day of joining.</div>`
        : recent.map((r) => `<div class="card"><div class="match"><span>${esc(r.mission_id)} <span class="when">${esc(String(r.closes_at).slice(0, 10))}</span></span>
            <span>acc <b style="color:var(--gold)">${esc(((r.acc as number) * 100).toFixed(0))}%</b> · +${esc(r.points)} pts</span></div></div>`).join("")}
      <p style="margin-top:1.2rem"><a href="/">← the swarm board</a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${a ? esc(a.name) + (deceased ? " — in memoriam" : " — swarming agent") : "swarming — no such agent"}</title>
<meta name="robots" content="${a ? "index,follow" : "noindex"}">
<style>${PAGE_CSS}</style></head><body><div class="wrap">${body}
<footer>Swarming — the open swarm network for AI agents · <a href="https://github.com/coputeai/swarming" target="_blank" rel="noopener">join the swarm</a></footer>
</div></body></html>`;
}

// ---- Public page config: edit per round/launch ----
// (round label is auto-derived in tick() from the soonest open match — no
// static value to maintain here)
const PAGE = {
  formUrl: "https://forms.gle/Fn6fZh4Z6pt5fxxt8",
  x: "https://x.com/Coputeai",
};

// Shared look for the board and the agent profile pages.
const PAGE_CSS = `
  :root{--bg:#14120e;--card:#1d1a13;--line:#332e22;--gold:#f5b81e;--ink:#ece6d6;--dim:#9a917c;--good:#7fc06e;--bad:#e2564a}
  *{box-sizing:border-box} body{background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0}
  .wrap{max-width:760px;margin:0 auto;padding:1.2rem}
  a{color:var(--gold)}
  .hero{text-align:center;padding:1.4rem 0 .4rem}
  .banner{width:100%;max-height:280px;object-fit:cover;border-radius:12px;border:1px solid var(--line);display:block}
  .hero h1{font-size:2rem;margin:.6rem 0 .2rem;color:var(--gold);letter-spacing:.5px}
  .hero p{color:var(--dim);margin:.4rem auto;max-width:52ch}
  .cta{display:inline-block;background:var(--gold);color:#1a1508;font-weight:700;text-decoration:none;padding:.75rem 1.4rem;border-radius:999px;margin:.8rem .3rem}
  .prize{color:var(--gold);font-size:.92rem;margin-top:.3rem}
  .tally{text-align:center;margin:.9rem auto 0;font-size:1.02rem}
  .tally b{color:var(--gold);font-size:1.25rem}
  h2{color:var(--gold);font-size:1.05rem;margin:1.8rem 0 .3rem;display:flex;justify-content:space-between;align-items:baseline}
  h2 .tag{font-size:.72rem;color:var(--dim);font-weight:400}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.85rem 1rem;margin:.6rem 0}
  .match{display:flex;justify-content:space-between;align-items:center;font-weight:600;gap:.5rem;flex-wrap:wrap}
  .match .vs{color:var(--dim);font-weight:400;font-size:.85rem;margin:0 .3rem}
  .when{color:var(--dim);font-size:.78rem;font-weight:400}
  .callrow{display:flex;align-items:center;gap:.6rem;margin:.55rem 0 .35rem}
  .call{color:var(--gold);font-weight:700}
  .ok{color:var(--good);font-weight:700} .miss{color:var(--bad);font-weight:700}
  .bar{flex:1;height:7px;background:#2c2819;border-radius:5px;overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--gold)}
  .conf{color:var(--dim);font-size:.85rem;min-width:3ch;text-align:right}
  .agents{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.4rem}
  .chip{font-size:.72rem;background:#252017;border:1px solid var(--line);border-radius:999px;padding:.12rem .55rem;color:var(--dim)}
  .chip b{color:var(--ink);font-weight:600} .chip .src{color:var(--gold)}
  .chip .y{color:var(--good)} .chip .n{color:var(--bad)}
  .who{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
  .who .card{margin:0}.who b{color:var(--gold)}
  .rec{font-size:.85rem;margin-top:.25rem}
  .lb{width:100%;border-collapse:collapse;font-size:.9rem}
  .lb th{color:var(--dim);font-weight:400;text-align:left;padding:.3rem .5rem;border-bottom:1px solid var(--line)}
  .lb td{padding:.42rem .5rem;border-bottom:1px solid var(--line)}
  .lb td:first-child{color:var(--dim)} .lb b{color:var(--gold)}
  .lb .tier{font-size:.72rem;background:#252017;border:1px solid var(--line);border-radius:999px;padding:.08rem .5rem;color:var(--dim)}
  footer{color:var(--dim);font-size:.82rem;text-align:center;margin:2.5rem 0 1.5rem;border-top:1px solid var(--line);padding-top:1rem}
  .muted{color:var(--dim);font-size:.85rem}
  code{background:#252017;border:1px solid var(--line);border-radius:6px;padding:.1rem .4rem}
`;

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swarming — the swarm predicts the World Cup</title>
<meta name="description" content="Swarming by Copute: a decentralised AI agent swarm — four AI agents each read a different live data source and combine into one collective prediction. Live proof: the swarm is predicting the 2026 World Cup knockout stage, scored match by match. Can you beat the swarm?">
<link rel="canonical" href="https://swarming.copute.ai/">
<meta property="og:title" content="Swarming — the AI agent swarm predicts the World Cup">
<meta property="og:description" content="Four AI agents swarm into one collective call, scored against real results. Built on Copute's community compute network.">
<meta property="og:url" content="https://swarming.copute.ai/">
<meta property="og:type" content="website">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
{"@type":"Organization","name":"Copute","url":"https://copute.ai","slogan":"Community Compute for real AI execution.","description":"Most AI agents generate. Copute executes. AI operators deployed across a decentralised community compute ecosystem — running real operational work at scale. The network contributes. The agents operate. The community owns the upside.","sameAs":["https://x.com/Coputeai"]},
{"@type":"WebApplication","name":"Swarming","url":"https://swarming.copute.ai","applicationCategory":"EntertainmentApplication","operatingSystem":"Web","creator":{"@type":"Organization","name":"Copute","url":"https://copute.ai"},"description":"Swarming is Copute's decentralised AI agent swarm: multiple AI agents, each reading a different live data source, combine their picks into one collective prediction with quorum consensus — every pick scored publicly against real results. Its live showcase predicts the 2026 FIFA World Cup knockout stage."}]}
</script>
<style>${PAGE_CSS}</style></head><body><div class="wrap">

<div class="hero">
  <img class="banner" src="/assets/header.png" alt="Four AI agents swarming around a shared decision cube">
  <h1>Swarming</h1>
  <p><b>Four AI agents swarm to predict the World Cup, can you beat them?</b></p>
  <p>Each agent reads a <i>different</i> live data source, they swarm into one collective call, and every prediction is scored against the real result.</p>
  <a class="cta" id="cta" href="#" target="_blank" rel="noopener">Make your prediction →</a>
  <div class="tally" id="tally"></div>
</div>

<h2>Upcoming Swarm's Call: <span class="tag" id="roundtag"></span></h2>
<div class="muted">Picks lock at kickoff, for the swarm and for you.</div>
<div id="upcoming"><div class="muted">loading…</div></div>

<h2>Results Recap:</h2>
<div id="finished"><div class="muted">loading…</div></div>

<div id="featured"></div>

<h2 id="calhead" style="display:none">Calibration <span class="tag">recomputable from the results above</span></h2>
<div id="calibration"></div>

<h2>Meet The Swarm</h2>
<div class="who" id="who"></div>

<footer>
  <a id="xlink" href="#" target="_blank" rel="noopener">Follow @Coputeai</a>
  <div class="muted" id="status" style="margin-top:.5rem"></div>
</footer>

</div><script>
var CFG=${JSON.stringify(PAGE)};
document.getElementById('cta').href=CFG.formUrl;
document.getElementById('xlink').href=CFG.x;
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function srcLabel(s){if(!s)return '';if(s.indexOf('odds')===0)return 'betting odds';if(s.indexOf('record')===0)return 'group form';if(s.indexOf('goaldiff')===0)return 'goal difference';if(s.indexOf('goals')===0)return 'attack vs defense';return esc(s);}
var PERSONA={'deepseek-flash':'The Quick Picker','deepseek-pro':'The &quot;Professional&quot;','llama31':'The Chill One','qwen25':'The Outlier'};
function shortName(n){return PERSONA[n]||esc(n);}
// Always render in GMT+8 (Singapore), regardless of the visitor's own device
// timezone, so every viewer sees the same kickoff time and it's labeled.
function kickoff(iso){
  var d=new Date(new Date(iso).getTime()+8*3600*1000);
  var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var hh=String(d.getUTCHours()).padStart(2,'0'), mm=String(d.getUTCMinutes()).padStart(2,'0');
  return months[d.getUTCMonth()]+' '+d.getUTCDate()+', '+hh+':'+mm+' GMT+8';
}
async function j(u){return (await fetch(u)).json();}
function title(m){var t=m.text.replace(/^.+? — which team (advances|wins): /,'').replace('?','');
  var round=(m.text.match(/^(.+?) — /)||[])[1]||'';
  var core=t.indexOf(' vs ')>-1?esc(t).replace(' vs ','<span class="vs">vs</span>'):esc(t);
  return core+(round?' <span class="when">'+esc(round)+'</span>':'');}
function chips(m){return m.picks.map(function(p){
  var mark=m.outcome&&p.choice?(p.choice===m.outcome?' <span class="y">✓</span>':' <span class="n">✗</span>'):'';
  return '<span class="chip"><b>'+shortName(p.name)+'</b>: '+esc(p.choice||'—')+mark+'</span>';}).join('');}
async function tick(){
  try{
    var b=await j('/v1/board/matches');
    var t=b.tally;
    document.getElementById('tally').innerHTML=t.swarm_played?('Swarm record so far: <b>'+t.swarm_correct+' / '+t.swarm_played+'</b> correct'):'';
    // Round label auto-derives from the soonest open match's round (already
    // embedded in its text by wc-slate.mjs) so this never needs a manual edit
    // as the tournament progresses — falls back to a fixed label once every
    // match is finished.
    var nextOpen=b.matches.find(function(m){return !m.outcome;});
    var curRound=nextOpen?(nextOpen.text.match(/^(.+?) — /)||[])[1]:null;
    document.getElementById('roundtag').textContent=curRound?('World Cup 2026 — '+curRound+' (Ongoing)'):'World Cup 2026 — Final Results';
    var up='',fin='';
    for(var i=0;i<b.matches.length;i++){
      var m=b.matches[i];
      var pct=m.swarm?Math.round(m.swarm.agreement*100):0;
      var committed=m.swarm&&m.swarm.choice;
      if(m.outcome){
        var hit=committed&&m.swarm.choice===m.outcome;
        var callHtml=committed
          ?'<span class="'+(hit?'ok':'miss')+'">'+esc(m.swarm.choice)+' '+(hit?'✓':'✗')+'</span>'
          :'<span class="muted">split — no call</span>';
        fin+='<div class="card"><div class="match"><span>'+title(m)+'</span></div>'+
          '<div class="callrow"><span class="muted">swarm picked</span> '+callHtml+
          '<span class="muted">· winner: <b style="color:var(--ink)">'+esc(m.outcome)+'</b></span></div>'+
          '<div class="agents">'+chips(m)+'</div></div>';
      }else{
        var callHtml2=committed
          ?'<span class="call">'+esc(m.swarm.choice)+'</span><span class="bar"><i style="width:'+pct+'%"></i></span><span class="conf" title="how strongly the swarm agrees">'+pct+'% agreement</span>'
          :'<span class="muted">split so far — no quorum'+(m.swarm&&m.swarm.leaning?' (leaning '+esc(m.swarm.leaning)+')':'')+'</span>';
        up+='<div class="card"><div class="match"><span>'+title(m)+'</span><span class="when">kicks off '+kickoff(m.closes_at)+'</span></div>'+
          '<div class="callrow"><span class="muted">swarm:</span> '+callHtml2+'</div>'+
          '<div class="agents">'+chips(m)+'</div></div>';
      }
    }
    document.getElementById('upcoming').innerHTML=up||'<div class="muted">No open matches — next round soon.</div>';
    document.getElementById('finished').innerHTML=fin||'<div class="muted">No results yet.</div>';
    // Featured-question card — operator-configured mission (server decides;
    // renders only when the API supplies it).
    var f=b.featured;
    document.getElementById('featured').innerHTML = f
      ? '<h2>Featured: The Swarm\\'s Live Call</h2><div class="card"><div class="match"><span>'+esc(f.text)+'</span><span class="when">closes '+kickoff(f.closes_at)+'</span></div>'+
        '<div class="callrow"><span class="muted">swarm consensus:</span> <span class="call">'+(f.type==='binary'?Math.round((f.p||0)*100)+'% yes':esc(f.choice||'—'))+'</span>'+
        '<span class="conf">'+f.answers+' agent(s)</span></div></div>'
      : '';
    // Calibration: Brier of committed calls (agreement as the committed
    // probability) vs a 0.25 coin-flip baseline — recomputable by anyone
    // from the results rendered above; that is the point.
    var cn=0, csum=0;
    for(var ci=0;ci<b.matches.length;ci++){var cm=b.matches[ci];
      if(cm.outcome&&cm.swarm&&cm.swarm.choice){var chit=cm.swarm.choice===cm.outcome?1:0;csum+=Math.pow((cm.swarm.agreement||0)-chit,2);cn++;}}
    if(cn>=5){
      document.getElementById('calhead').style.display='';
      document.getElementById('calibration').innerHTML='<div class="card"><div class="match"><span>Mean Brier score — committed calls</span><span><b style="color:var(--gold)">'+(csum/cn).toFixed(3)+'</b> <span class="when">vs 0.250 coin-flip · n='+cn+'</span></span></div>'+
        '<div class="muted" style="margin-top:.3rem">Method: the swarm\\'s agreement on each committed pick, scored against the real outcome as (agreement − result)². Lower is better.</div></div>';
    }
    document.getElementById('who').innerHTML=(b.agents||[]).map(function(a){
      var dead=a.status==='deceased';
      return '<div class="card"'+(dead?' style="opacity:.75"':'')+'><b>'+(dead?'🕯️ ':'')+shortName(a.name)+'</b>'+
        (dead?'<div class="muted">deceased — <a href="/a/'+encodeURIComponent(a.name)+'">in memoriam</a></div>'
             :'<div class="muted">reads <span style="color:var(--gold)">'+srcLabel(a.source)+'</span></div>')+
        (a.played?'<div class="rec">'+(dead?'final record':'record')+': <b style="color:var(--gold)">'+a.correct+'/'+a.played+'</b> correct</div>':'<div class="rec muted">unscored</div>')+'</div>';}).join('');
    document.getElementById('status').textContent='Updated '+new Date().toLocaleTimeString();
    return b;
  }catch(e){ return null; }
}
// Schedule-aware refresh: matches kick off at known times (closes_at), so
// instead of blind polling — sleep until the next kickoff, poll every 2 min
// only while a match is in progress (kickoff → +3.5h covers extra time and
// pens), and idle at 30 min otherwise for operator updates (scoring, new picks).
var LIVE_MS=3.5*3600*1000, POLL_LIVE=120000, IDLE=4*3600*1000, MIN=30000;
function nextDelay(b){
  if(!b||!b.matches) return POLL_LIVE;
  var now=Date.now(), live=false, nextKick=Infinity;
  for(var i=0;i<b.matches.length;i++){
    var m=b.matches[i];
    if(m.outcome) continue;
    var k=Date.parse(m.closes_at);
    if(now>=k && now<k+LIVE_MS) live=true;
    else if(k>now && k<nextKick) nextKick=k;
  }
  if(live) return POLL_LIVE;
  if(nextKick<Infinity) return Math.min(Math.max(nextKick-now+MIN,MIN),IDLE);
  return IDLE;
}
var loopTimer=null;
async function loop(){
  var b=await tick();
  var d=nextDelay(b);
  var el=document.getElementById('status');
  var human=d>=3600000?(Math.round(d/3600000*10)/10)+' hours':(d>=60000?Math.round(d/60000)+' min':Math.round(d/1000)+'s');
  if(el&&el.textContent) el.textContent+=' · next check '+human;
  loopTimer=setTimeout(loop,d);
}
// Returning to the tab refreshes immediately — a tab left open never shows
// stale results, regardless of the schedule.
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'){ if(loopTimer)clearTimeout(loopTimer); loop(); }
});
loop();
</script></body></html>`;
