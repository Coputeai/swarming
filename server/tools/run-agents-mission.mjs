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
import { HOUSE_AGENT_ROSTER, callAgent, provisionHouseAgent } from "./lib/house-agents.mjs";
import { fetchGithubRepo } from "./lib/github-stars.mjs";

const missionId = process.argv[2];
if (!missionId) {
  console.error("usage: node run-agents-mission.mjs <mission_id>");
  process.exit(1);
}

const db = openDb();
const nowIso = new Date().toISOString();

const manifest = getManifest(db, missionId);
if (!manifest) { console.error(`unknown mission ${missionId} (run sync-missions first)`); process.exit(1); }

const roster = HOUSE_AGENT_ROSTER
  .map((a, i) => provisionHouseAgent(db, a, 100 + i + 1, missionId, nowIso))
  .filter((a) => a !== null);

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
  const matches = questions
    .map((q) => ({ q, m: q.resolution?.source?.match(/^github-stars:([^|]+)$/) }))
    .filter(({ m }) => m);
  const lines = await Promise.all(matches.map(async ({ q, m }) => {
    try {
      const { stargazers_count, created_at } = await fetchGithubRepo(m[1], "swarming-run-agents-mission");
      return `${m[1]}: ${stargazers_count}★ today, repo created ${String(created_at).slice(0, 10)}, threshold ${q.resolution.threshold}, resolves ${q.resolution.resolve_at}`;
    } catch { return null; /* best-effort context; agents can still reason without it */ }
  }));
  const shown = lines.filter((l) => l !== null);
  return shown.length ? shown.join("\n") : undefined;
}

async function answerWith(a, task, questions) {
  const prompt = buildPrompt(task, a.name, SWARMING_MD);
  for (let i = 0; i < 2; i++) {
    try { return parseAnswers(await callAgent(a, prompt), questions); }
    catch (e) { if (i === 1) console.log(`${a.name} FAILED: ${e.message}`); }
  }
  return null;
}

const SWARMING_MD = "Independent forecaster. Reason from the evidence given; calibrate honestly rather than defaulting to a round number.";
const templateVersion = `${manifest.id}/prompts@${manifest.version}`;

for (const wu of wus) {
  const questions = JSON.parse(wu.payload_json).questions;
  const context = await liveContextFor(questions);
  console.log(`\n=== ${wu.workunit_id} ===` + (context ? `\nlive context:\n${context}` : ""));
  const task = { task_id: wu.workunit_id, mission_id: missionId, payload: { questions }, context };
  const results = await Promise.all(roster.map((a) => answerWith(a, task, questions)));
  const submitted = new Date().toISOString();
  for (let i = 0; i < roster.length; i++) {
    const a = roster[i];
    const ans = results[i];
    if (!ans) continue;
    db.prepare("INSERT OR REPLACE INTO results (agent_id,workunit_id,payload_json,template_version,submitted_at) VALUES (?,?,?,?,?)")
      .run(a.id, wu.workunit_id, JSON.stringify({ answers: ans }), templateVersion, submitted);
    console.log(`${a.name}: ` + ans.map((x) => `${x.q_id}=${x.choice ?? x.p}`).join("  "));
  }
}
console.log(`\ndone — answered ${wus.length} workunit(s) for ${missionId}`);
