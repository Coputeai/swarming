// Operator tool: run the showcase's 4 reference agents against every OPEN
// pre-kickoff claim-check workunit. Each agent reads a DIFFERENT live data
// source (its own evidence), answers via the real prompt builder + parser, and
// results are written to the operator's DB. This is the operator harness for
// the reference swarm — independent agents join and submit through the signed
// CLI protocol instead.
//   SWARMING_DB=server/data/staging.db node server/tools/run-agents.mjs
// Requires: DEEPSEEK_API_KEY env var, Ollama running locally.
// Never resets reputation: agents are created at the protocol cold-start
// baseline once and earn skill/points only through scoring.
import { openDb } from "../src/db.ts";
import { buildPrompt, parseAnswers } from "../../packages/cli/src/predict.ts";
import { fetchSource } from "../../packages/cli/src/tools.ts";

const db = openDb();
const dk = process.env.DEEPSEEK_API_KEY;
const nowIso = new Date().toISOString();

// Each agent reads a DIFFERENT data source — divergence comes from what they
// look at, not just which model they are.
const agents = [
  { name: "deepseek-pro",   mc: "deepseek/deepseek-v4-pro",   prov: "deepseek", model: "deepseek-v4-pro",   source: "odds:all" },
  { name: "deepseek-flash", mc: "deepseek/deepseek-v4-flash", prov: "deepseek", model: "deepseek-v4-flash", source: "record:all" },
  { name: "llama31",        mc: "ollama/llama3.1:8b",         prov: "ollama",   model: "llama3.1:8b",        source: "goaldiff:all" },
  { name: "qwen25",         mc: "ollama/qwen2.5:7b",          prov: "ollama",   model: "qwen2.5:7b",         source: "goals:all" },
];
let n = 0;
for (const a of agents) {
  n += 1; a.id = "agent_st_" + a.name;
  // create-if-missing at cold-start baseline; NEVER overwrite earned reputation
  db.prepare(`INSERT OR IGNORE INTO agents (agent_id,pubkey,name,agent_number,model_class,capabilities_json,created_at,last_seen_at,skill,points,streak,tier_index,scored_count)
              VALUES (?,?,?,?,?,'["llm.reasoning","data.read"]',?,?,0.5,0,0,0,0)`)
    .run(a.id, "pk_st_" + a.name, a.name, 100 + n, a.mc, nowIso, nowIso);
  db.prepare("INSERT OR REPLACE INTO subscriptions (agent_id,mission_id,enabled,updated_at) VALUES (?, 'claim-check', 1, ?)").run(a.id, nowIso);
}

// Open workunits whose kickoff hasn't passed — picks lock at kickoff.
const wus = db.prepare(
  "SELECT workunit_id, payload_json, closes_at FROM workunits WHERE mission_id='claim-check' AND status='open' AND closes_at > ? ORDER BY closes_at",
).all(nowIso);
if (wus.length === 0) { console.log("no open pre-kickoff workunits"); process.exit(0); }
console.log(`answering ${wus.length} open match(es), lock times ${wus[0].closes_at} … ${wus[wus.length - 1].closes_at}`);

// One combined question slate per agent run (one model call), split back into
// per-match results afterwards.
const byQid = new Map(); // q_id -> workunit_id
const questions = [];
for (const wu of wus) {
  const q = JSON.parse(wu.payload_json).questions[0];
  byQid.set(q.q_id, wu.workunit_id);
  questions.push(q);
}
const slateTeams = new Set();
for (const q of questions) for (const c of (q.choices ?? [])) slateTeams.add(c);

const SWARMING_MD = "Independent forecaster. Weigh your live data heavily; only diverge from what it indicates when you have a concrete reason. Calibrate honestly.";

async function call(a, prompt) {
  if (a.prov === "deepseek") {
    const r = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dk}` }, body: JSON.stringify({ model: a.model, messages: [{ role: "user", content: prompt }] }) });
    if (!r.ok) throw new Error("deepseek " + r.status); return (await r.json()).choices[0].message.content;
  }
  const r = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: a.model, messages: [{ role: "user", content: prompt }], stream: false }) });
  if (!r.ok) throw new Error("ollama " + r.status); return (await r.json()).message.content;
}

// Parse a team-keyed blob ("PREFIX — Team val; Team val; ...") into Team->val.
function teamMap(ctx) {
  const m = new Map();
  const i = ctx.indexOf(" — ");
  if (i < 0) return m;
  for (const seg of ctx.slice(i + 3).split(";").map((s) => s.trim()).filter(Boolean)) {
    let best = null;
    for (const t of slateTeams) if (seg.startsWith(t) && (!best || t.length > best.length)) best = t;
    if (best) m.set(best, seg.slice(best.length).trim());
  }
  return m;
}

// Reshape a team-keyed source into a PER-MATCH view: each tie is a choice
// between exactly 2 teams, so show only those 2 teams' stat, side by side.
function perMatchContext(ctx) {
  const i = ctx.indexOf(" — ");
  const prefix = i < 0 ? "" : ctx.slice(0, i);
  const map = teamMap(ctx);
  const lines = [];
  for (const q of questions) {
    if ((q.choices ?? []).length !== 2) continue;
    const [a, b] = q.choices;
    lines.push(`${a} ${map.get(a) ?? "?"} vs ${b} ${map.get(b) ?? "?"}`);
  }
  return lines.length ? `${prefix} — ` + lines.join("; ") : ctx;
}

// odds:all is already per-match; standings-derived sources are per-team.
const TEAM_KEYED = new Set(["record:all", "goaldiff:all", "goals:all"]);

for (const a of agents) {
  const raw = await fetchSource(a.source);
  const ctx = raw && TEAM_KEYED.has(a.source) ? perMatchContext(raw) : raw;
  console.log(`\n--- ${a.name} reads [${a.source}] ---\n` + (ctx ? ctx.slice(0, 220) + (ctx.length > 220 ? " ..." : "") : "(no context)"));
  const task = { task_id: "combined", mission_id: "claim-check", payload: { questions }, context: ctx ?? undefined };
  const prompt = buildPrompt(task, a.name, SWARMING_MD);
  let ans = null;
  for (let i = 0; i < 2 && !ans; i++) {
    try { ans = parseAnswers(await call(a, prompt), questions); }
    catch (e) { if (i === 1) console.log(a.name + " FAILED: " + e.message); }
  }
  if (!ans) continue;
  const submitted = new Date().toISOString();
  for (const x of ans) {
    const wuId = byQid.get(x.q_id);
    if (!wuId) continue;
    db.prepare("INSERT OR REPLACE INTO results (agent_id,workunit_id,payload_json,template_version,submitted_at) VALUES (?,?,?,'claim',?)")
      .run(a.id, wuId, JSON.stringify({ answers: [x], source: a.source }), submitted);
  }
  console.log(a.name + ": " + ans.map((x) => (x.q_id.replace(/^adv_/, "") + "=" + (x.choice ?? x.p))).join("  "));
}
console.log(`\ndone — answered across ${wus.length} match workunit(s)`);
