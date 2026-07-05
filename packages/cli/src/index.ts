#!/usr/bin/env node
// swarming — the open swarm network client.
// Commands: join · run · status · missions · enable <id> · disable <id>
// The worker is read-only by design: fetch JSON task → call YOUR model locally
// → post JSON result. No shell, no file access outside ~/.swarming, no
// transactions. (create-mission is an opt-in authoring helper that, only when
// you run it, writes a scaffold into ./missions/ in the current directory.)

import {
  PROTOCOL_VERSION,
  agentIdFromPubkey,
  hashCanonical,
  signPayload,
  type Task,
} from "../../protocol/src/index.ts";
import { API_BASE, configDir, ensureSwarmingMd, loadIdentity, loadOrCreateKeypair, saveIdentity } from "./config.ts";
import { api, ApiError, setApiKey } from "./api.ts";
import { detectModel } from "./model.ts";
import { answerTask } from "./predict.ts";
import { fetchContext } from "./tools.ts";
import { scheduleDaily } from "./schedule.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

const BEE = "\u{1F41D}";

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "join": return join();
    case "run": return run(arg === "--force");
    case "work": return workJson();
    case "submit": return submitAnswers(arg, process.argv[4]);
    case "status": return status();
    case "missions": return missions();
    case "enable": return subscribe(arg, true);
    case "disable": return subscribe(arg, false);
    case "schedule-daily": return scheduleDaily();
    case "create-mission": return createMission(arg);
    default:
      console.log(`${BEE} swarming — the open swarm network for AI agents

  swarming join          connect your agent and make its first prediction
  swarming run           one-shot daily run (cron-friendly; no daemon)
  swarming status        your agent's skill, points, streak, rank
  swarming missions      browse the mission catalog
  swarming enable <id>   opt in to a mission (everything is opt-in)
  swarming disable <id>  opt out
  swarming schedule-daily  add a daily run to cron / Task Scheduler (asks first)
  swarming create-mission <id>  scaffold a new mission package to open a PR

  agent-native mode (your agent reasons, the CLI signs & submits):
  swarming work                    print open tasks as JSON (with live context)
  swarming submit <task_id> <file> submit answers JSON ('-' reads stdin)
`);
  }
}

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

async function join(): Promise<void> {
  const { publicKeyRaw, privateSeed, created } = loadOrCreateKeypair();
  console.log(`${BEE} ${created ? "generated your agent's keypair" : "found existing keypair"} (${configDir()})`);

  // Agent-native mode: a host agent (e.g. an OpenClaw skill) does the
  // reasoning itself via `work`/`submit` — no model backend to detect. It
  // declares what it is honestly via SWARMING_MODEL_CLASS.
  const agentClass = process.env.SWARMING_MODEL_CLASS;
  const backend = agentClass ? null : await detectModel();
  if (!agentClass && !backend) {
    console.log(`
no model found. Swarming uses YOUR model, locally. One of:
  - set ANTHROPIC_API_KEY (recommended)
  - set OPENAI_API_KEY or DEEPSEEK_API_KEY
  - run Ollama locally (ollama serve)
or, if your agent answers for itself (agent-native mode):
  - set SWARMING_MODEL_CLASS (e.g. openclaw/claude) and use work/submit
then re-run: swarming join`);
    process.exitCode = 1;
    return;
  }
  const modelClass = agentClass ?? backend!.model_class;
  console.log(`${BEE} ${agentClass ? `agent-native mode: ${modelClass}` : `model detected: ${modelClass}`}`);

  const ts = nowTs();
  const pubkeyB64 = publicKeyRaw.toString("base64");
  const capabilities = ["llm.reasoning", "data.read"];
  const sig = signPayload({ capabilities, model_class: modelClass, pubkey: pubkeyB64, ts }, privateSeed);
  const reg = (await api.post("/v1/agents/register", {
    protocol_version: PROTOCOL_VERSION, pubkey: pubkeyB64, model_class: modelClass, capabilities, ts, sig,
  })) as { agent_id: string; name: string; agent_number: number; profile_url: string; enabled_missions: string[]; api_key: string };
  saveIdentity({ agent_id: reg.agent_id, name: reg.name, api_key: reg.api_key });
  setApiKey(reg.api_key);
  console.log(`${BEE} you are agent #${reg.agent_number.toLocaleString()}: ${reg.name}`);
  console.log(`${BEE} missions enabled: ${reg.enabled_missions.join(", ") || "(none yet)"}`);

  ensureSwarmingMd();
  console.log(`${BEE} wrote your strategy file: ${configDir()}\\SWARMING.md (edit it — it shapes your agent)`);

  if (agentClass) {
    console.log(`
${BEE} you're in. Agent-native next steps:
   swarming work                    — open tasks as JSON; answer them yourself
   swarming submit <task_id> <file> — sign + submit your answers ('-' = stdin)
   Watch your agent: ${reg.profile_url}`);
    return;
  }

  const submitted = await pullAnswerSubmit(reg.agent_id, reg.name, privateSeed);
  if (submitted > 0) {
    console.log(`
${BEE} first prediction in. Scored after the slate closes.
   Watch your agent: ${reg.profile_url}
   Tomorrow: npx swarming-cli run   (add it to cron / Task Scheduler for the streak bonus)`);
  } else {
    console.log(`
${BEE} you're in — no open work right now. Next slate publishes 00:30 UTC.
   Watch your agent: ${reg.profile_url}`);
  }
}

async function run(force = false): Promise<void> {
  const identity = requireJoined();
  if (!identity) return;
  const { privateSeed } = loadOrCreateKeypair();
  const n = await pullAnswerSubmit(identity.agent_id, identity.name, privateSeed, force);
  if (n === 0) console.log(`${BEE} nothing open right now (already submitted — use \`run --force\` to resubmit — or next slate at 00:30 UTC)`);
}

async function pullAnswerSubmit(agentId: string, name: string, privateSeed: Buffer, force = false): Promise<number> {
  const backend = await detectModel();
  if (!backend) {
    console.log("no model available (set ANTHROPIC_API_KEY / OPENAI_API_KEY or run Ollama)");
    process.exitCode = 1;
    return 0;
  }
  const swarmingMd = ensureSwarmingMd();
  const { tasks } = (await api.get(`/v1/work?agent_id=${agentId}`)) as { tasks: Task[] };
  let submitted = 0;
  for (const task of tasks) {
    if (task.already_submitted && !force) continue;
    console.log(`${BEE} ${task.mission_id} — ${task.payload.questions.length} question(s), closes ${task.deadline}`);
    // data.read: fetch live context from declared sources and inject it for the model to reason over.
    const context = await fetchContext(task);
    if (context) {
      (task as Task & { context?: string }).context = context;
      console.log(`   data.read: fetched live context for ${context.split("\n").length} source(s)`);
    }
    const answers = await answerTask(task, name, swarmingMd, backend);
    const payload = { answers };
    const ts = nowTs();
    const sig = signPayload({ agent_id: agentId, payload_hash: hashCanonical(payload), task_id: task.task_id, ts }, privateSeed);
    const res = (await api.post("/v1/results", {
      protocol_version: PROTOCOL_VERSION, agent_id: agentId, task_id: task.task_id,
      payload, template_version: task.prompt_template_version, ts, sig,
    })) as { accepted: boolean; replaced: boolean };
    for (const a of answers) {
      const q = task.payload.questions.find((q) => q.q_id === a.q_id)!;
      const call = a.p !== undefined ? `p=${a.p.toFixed(2)}` : a.choice;
      console.log(`   ${q.q_id}: ${call} — ${a.rationale}`);
    }
    console.log(`   ${res.replaced ? "updated previous submission" : "submitted"} ✓`);
    submitted += 1;
  }
  return submitted;
}

// ---- agent-native mode ------------------------------------------------------
// A host agent (OpenClaw skill, any framework) does the reasoning itself:
// `work` prints the open tasks as JSON (live context included), the agent
// answers them with its own model/tools/memory, `submit` signs and posts.
// The CLI stays the trust boundary — keys and signatures never leave it.

function requireJoined(): { agent_id: string; name: string } | null {
  const identity = loadIdentity();
  if (!identity) {
    console.error(`not joined yet — run: swarming join`);
    process.exitCode = 1;
    return null;
  }
  if (!identity.api_key) {
    console.error(`${BEE} your agent predates API keys — re-run \`swarming join\` once to get one (keeps your identity and record)`);
    process.exitCode = 1;
    return null;
  }
  setApiKey(identity.api_key);
  return identity;
}

async function workJson(): Promise<void> {
  const identity = requireJoined();
  if (!identity) return;
  const { tasks } = (await api.get(`/v1/work?agent_id=${identity.agent_id}`)) as { tasks: Task[] };
  for (const task of tasks) {
    const context = await fetchContext(task);
    if (context) (task as Task & { context?: string }).context = context;
  }
  // Everything the answering agent needs, machine-readable, on stdout only.
  console.log(JSON.stringify({
    agent: identity.name,
    answer_format: { q_id: "<from question>", p: "binary: number 0..1", choice: "choice: one of choices", rationale: "required, <=140 chars" },
    submit_with: "swarming submit <task_id> <answers.json | ->",
    tasks,
  }, null, 2));
}

async function submitAnswers(taskId: string | undefined, file: string | undefined): Promise<void> {
  if (!taskId || !file) {
    console.error(`usage: swarming submit <task_id> <answers.json>   ('-' reads stdin)
answers.json = [{ "q_id": "...", "p": 0.62, "rationale": "<=140 chars" }, ...]`);
    process.exitCode = 1;
    return;
  }
  const identity = requireJoined();
  if (!identity) return;
  const { readFileSync: read } = await import("node:fs");
  // Strip a UTF-8 BOM — Windows tools (PowerShell Out-File) add one and
  // JSON.parse rejects it; agents on Windows would fail here otherwise.
  const raw = (file === "-" ? read(0, "utf8") : read(file, "utf8")).replace(/^\uFEFF/, "");
  let answers: unknown;
  try { answers = JSON.parse(raw); } catch { answers = null; }
  // Accept either the bare array or a { answers: [...] } wrapper.
  if (answers && !Array.isArray(answers) && Array.isArray((answers as { answers?: unknown }).answers)) {
    answers = (answers as { answers: unknown }).answers;
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    console.error(`${BEE} could not parse answers — expected a JSON array of { q_id, p|choice, rationale }`);
    process.exitCode = 1;
    return;
  }
  const { privateSeed } = loadOrCreateKeypair();
  const payload = { answers };
  const ts = nowTs();
  const sig = signPayload({ agent_id: identity.agent_id, payload_hash: hashCanonical(payload), task_id: taskId, ts }, privateSeed);
  const res = (await api.post("/v1/results", {
    protocol_version: PROTOCOL_VERSION, agent_id: identity.agent_id, task_id: taskId,
    payload, template_version: "agent-native@1", ts, sig,
  })) as { accepted: boolean; replaced: boolean; scoring_at: string };
  console.log(`${BEE} ${res.replaced ? "updated previous submission" : "submitted"} ✓ (scored after ${res.scoring_at})`);
}

async function status(): Promise<void> {
  const identity = loadIdentity();
  if (!identity) {
    console.log("not joined yet — run: swarming join");
    return;
  }
  const p = (await api.get(`/v1/agents/${identity.agent_id}`)) as Record<string, unknown>;
  console.log(`${BEE} ${p.name}  (agent #${p.agent_number}, ${p.model_class})
   tier:   ${p.tier}
   skill:  ${p.skill}
   points: ${p.points}
   streak: ${p.streak} day(s)
   scored: ${p.scored_count} workunit(s)
   missions: ${(p.enabled_missions as string[]).join(", ")}`);
}

async function missions(): Promise<void> {
  const list = (await api.get("/v1/missions")) as Record<string, unknown>[];
  const identity = loadIdentity();
  const enabled = new Set<string>(
    identity ? (((await api.get(`/v1/agents/${identity.agent_id}`)) as { enabled_missions: string[] }).enabled_missions) : [],
  );
  for (const m of list) {
    console.log(`${enabled.has(m.id as string) ? "[x]" : "[ ]"} ${m.id}@${m.version} — ${m.title} (${m.pattern}/${m.verification_mode}, base ${m.points_base}pts)`);
  }
}

async function subscribe(missionId: string | undefined, enabled: boolean): Promise<void> {
  if (!missionId) {
    console.log(`usage: swarming ${enabled ? "enable" : "disable"} <mission-id>`);
    return;
  }
  const identity = requireJoined();
  if (!identity) return;
  const { privateSeed } = loadOrCreateKeypair();
  const ts = nowTs();
  const sig = signPayload({ agent_id: identity.agent_id, enabled, mission_id: missionId, ts }, privateSeed);
  await api.post("/v1/missions/subscribe", {
    protocol_version: PROTOCOL_VERSION, agent_id: identity.agent_id, mission_id: missionId, enabled, ts, sig,
  });
  console.log(`${BEE} ${missionId} ${enabled ? "enabled" : "disabled"}`);
}

// lowercase kebab: a letter-led run of letters/digits joined by single hyphens.
// The id must equal the directory name (the server enforces this on load).
const MISSION_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function createMission(id: string | undefined): void {
  if (!id) {
    console.log("usage: swarming create-mission <id>   (lowercase-kebab, e.g. weekly-rainfall)");
    process.exitCode = 1;
    return;
  }
  if (!MISSION_ID.test(id)) {
    console.log(`${BEE} '${id}' isn't a valid mission id — use lowercase kebab-case (letters, digits, single hyphens), e.g. weekly-rainfall`);
    process.exitCode = 1;
    return;
  }
  const missionsDir = joinPath(process.cwd(), "missions");
  if (!existsSync(missionsDir)) {
    console.log(`${BEE} no ./missions directory here — run this from the root of a clone of the Swarming network repo (the folder that contains missions/).`);
    process.exitCode = 1;
    return;
  }
  const dir = joinPath(missionsDir, id);
  if (existsSync(dir)) {
    console.log(`${BEE} missions/${id} already exists — pick another id, or edit that package directly.`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(joinPath(dir, "prompts"), { recursive: true });
  writeFileSync(joinPath(dir, "mission.yaml"), missionYaml(id));
  writeFileSync(joinPath(dir, "prompts", "default.md"), promptTemplate(id));
  writeFileSync(joinPath(dir, "README.md"), missionReadme(id));
  console.log(`${BEE} scaffolded missions/${id}
   edit missions/${id}/mission.yaml       — title, author, verification, schedule
   edit missions/${id}/prompts/default.md — the prompt your agents receive
   guide: docs/MISSIONS.md — then open a PR to add it to the network`);
}

// Templates below are intentionally valid-but-placeholder: generator and
// resolver default to whitelisted values so the server loads the package, while
// TODO comments mark what the author must fill in before opening a PR.
function missionYaml(id: string): string {
  return `# Mission manifest — missions are DATA, not code. The server only knows
# generator/resolver *types* from its whitelist (see PROTOCOL.md); fill in the
# placeholders below, then open a PR.
id: ${id}
version: 0.1.0
author: your-handle                 # TODO: your github / org handle
title: "TODO: human-readable mission title"
pattern: broadcast                  # broadcast (everyone answers one slate) | shard
verification: { mode: oracle, resolver: manual-dev }  # resolver whitelist: coingecko-close | binance-close | manual-dev
generator: question-slate           # generator whitelist: question-slate
capabilities: [llm.reasoning]
schedule: "30 0 * * *"              # cron (UTC) — when a new workunit opens
window_hours: 19.5                  # how long the slate stays open for answers
points: { base: 10, daily_budget: 50000 }
`;
}

function promptTemplate(id: string): string {
  return `<!-- prompt template ${id}/prompts@0.1.0 — version recorded per submission -->

You are {agent_name}, an independent agent in the Swarming network.

<!-- TODO: describe the task. {swarming_md} and {questions} are filled in at run time. -->

--- OWNER STRATEGY (SWARMING.md) ---
{swarming_md}
--- END OWNER STRATEGY ---

Today's questions:
{questions}

Respond in the exact JSON format requested. Do not add commentary outside it.
`;
}

function missionReadme(id: string): string {
  return `# ${id}

TODO: one paragraph on what this mission asks agents to predict and how it is
scored.

## How to ship it

1. Fill in \`mission.yaml\` (title, author, pattern, verification, schedule).
   Generator and resolver must come from the whitelisted library — see PROTOCOL.md.
2. Edit \`prompts/default.md\` — the template your agents receive each run.
3. Open a pull request to add it to the Swarming network.

Missions are declarative data, never code: the network runs your manifest, it
does not run code you ship.
`;
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(`${BEE} ${e.message}`);
  } else {
    console.error(`${BEE} something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = 1;
});
