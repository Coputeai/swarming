// Operator tool: run the showcase's 4 reference agents against every OPEN
// workunit of a given mission. Mission-generic version of run-agents.mjs (that
// one stays as-is for claim-check's per-agent live-data-source personalization
// — WC-specific behavior this script deliberately does NOT replicate). Use
// this for any other mission the house agents should answer, e.g. one-off
// mission slates that aren't wired into the evergreen loop.
//   SWARMING_DB=... node server/tools/run-agents-mission.mjs <mission_id>
// Requires: DEEPSEEK_API_KEY, GEMINI_API_KEY, GROQ_API_KEY env vars.
// Same operator-harness pattern as run-agents.mjs: writes results directly to
// the DB (house agents are operator-controlled, so this bypasses the signed
// HTTP submit path real network agents use) and never resets reputation.
import { openDb } from "../src/db.ts";
import { getManifest } from "../src/missions.ts";
import { buildPrompt, parseAnswers } from "../../packages/cli/src/predict.ts";

const missionId = process.argv[2];
if (!missionId) {
  console.error("usage: node run-agents-mission.mjs <mission_id>");
  process.exit(1);
}

const db = openDb();
const nowIso = new Date().toISOString();

const manifest = getManifest(db, missionId);
if (!manifest) { console.error(`unknown mission ${missionId} (run sync-missions first)`); process.exit(1); }

// Same 4 house agents as run-agents.mjs, without a forced per-agent live-data
// source — a generic mission has no "each agent reads a different stat"
// concept. Independence here comes from 4 different models reasoning over
// the same evidence, not from feeding them different inputs.
const agents = [
  { name: "deepseek-pro",   mc: "deepseek/deepseek-v4-pro",   url: "https://api.deepseek.com/chat/completions",                                keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-v4-pro" },
  { name: "deepseek-flash", mc: "deepseek/deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions",                                keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-v4-flash" },
  { name: "llama31",        mc: "gemini/gemini-2.5-flash",    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY",   model: "gemini-2.5-flash" },
  { name: "qwen25",         mc: "groq/qwen3-32b",             url: "https://api.groq.com/openai/v1/chat/completions",                          keyEnv: "GROQ_API_KEY",     model: "qwen/qwen3-32b" },
];
let n = 0;
const roster = [];
for (const a of agents) {
  n += 1; a.id = "agent_st_" + a.name;
  // A deceased agent stays deceased — never re-subscribe or answer for it.
  const prior = db.prepare("SELECT status FROM agents WHERE agent_id = ?").get(a.id);
  if (prior?.status === "deceased") { console.log(`${a.name}: deceased — skipping`); continue; }
  // create-if-missing at cold-start baseline; NEVER overwrite earned reputation
  db.prepare(`INSERT OR IGNORE INTO agents (agent_id,pubkey,name,agent_number,model_class,capabilities_json,created_at,last_seen_at,skill,points,streak,tier_index,scored_count)
              VALUES (?,?,?,?,?,'["llm.reasoning"]',?,?,0.5,0,0,0,0)`)
    .run(a.id, "pk_st_" + a.name, a.name, 100 + n, a.mc, nowIso, nowIso);
  db.prepare("INSERT OR REPLACE INTO subscriptions (agent_id,mission_id,enabled,updated_at) VALUES (?, ?, 1, ?)").run(a.id, missionId, nowIso);
  roster.push(a);
}

const wus = db.prepare(
  "SELECT workunit_id, payload_json, closes_at FROM workunits WHERE mission_id = ? AND status = 'open' AND closes_at > ? ORDER BY closes_at",
).all(missionId, nowIso);
if (wus.length === 0) { console.log(`no open workunits for ${missionId}`); process.exit(0); }
console.log(`answering ${wus.length} open workunit(s) for ${missionId}`);

// Generic live-context helper: if a question's resolution cites a
// single-repo github-stars source (the same resolver admin.ts's --auto
// resolve uses), fetch and show the real current count — grounding every
// agent in the same real evidence rather than a guess, without this script
// knowing anything mission-specific about self-bet.
async function liveContextFor(questions) {
  const lines = [];
  for (const q of questions) {
    const m = q.resolution?.source?.match(/^github-stars:([^|]+)$/);
    if (!m) continue;
    try {
      const r = await fetch(`https://api.github.com/repos/${m[1]}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "swarming-run-agents-mission" },
        signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) continue;
      const { stargazers_count, created_at } = await r.json();
      lines.push(`${m[1]}: ${stargazers_count}★ today, repo created ${String(created_at).slice(0, 10)}, threshold ${q.resolution.threshold}, resolves ${q.resolution.resolve_at}`);
    } catch { /* best-effort context; agents can still reason without it */ }
  }
  return lines.length ? lines.join("\n") : undefined;
}

async function call(a, prompt) {
  const key = process.env[a.keyEnv];
  if (!key) throw new Error(`missing env ${a.keyEnv}`);
  const r = await fetch(a.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: a.model, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`${a.model} HTTP ${r.status}`);
  const content = (await r.json()).choices[0].message.content;
  // reasoning models (e.g. qwen3) may emit <think>…</think> before the JSON —
  // strip it so stray brackets in the reasoning can't corrupt parsing
  return String(content).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const SWARMING_MD = "Independent forecaster. Reason from the evidence given; calibrate honestly rather than defaulting to a round number.";
const templateVersion = `${manifest.id}/prompts@${manifest.version}`;

for (const wu of wus) {
  const questions = JSON.parse(wu.payload_json).questions;
  const context = await liveContextFor(questions);
  console.log(`\n=== ${wu.workunit_id} ===` + (context ? `\nlive context:\n${context}` : ""));
  const task = { task_id: wu.workunit_id, mission_id: missionId, payload: { questions }, context };
  for (const a of roster) {
    const prompt = buildPrompt(task, a.name, SWARMING_MD);
    let ans = null;
    for (let i = 0; i < 2 && !ans; i++) {
      try { ans = parseAnswers(await call(a, prompt), questions); }
      catch (e) { if (i === 1) console.log(`${a.name} FAILED: ${e.message}`); }
    }
    if (!ans) continue;
    const submitted = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO results (agent_id,workunit_id,payload_json,template_version,submitted_at) VALUES (?,?,?,?,?)")
      .run(a.id, wu.workunit_id, JSON.stringify({ answers: ans }), templateVersion, submitted);
    console.log(`${a.name}: ` + ans.map((x) => `${x.q_id}=${x.choice ?? x.p}`).join("  "));
  }
}
console.log(`\ndone — answered ${wus.length} workunit(s) for ${missionId}`);
