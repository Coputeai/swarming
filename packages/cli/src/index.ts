#!/usr/bin/env node
// swarming — the open swarm network client.
// Commands: join · run · status · missions · enable <id> · disable <id>
// Read-only by design: fetch JSON task → call YOUR model locally → post JSON
// result. No shell, no file access outside ~/.swarming, no transactions.

import {
  PROTOCOL_VERSION,
  agentIdFromPubkey,
  hashCanonical,
  signPayload,
  type Task,
} from "../../protocol/src/index.ts";
import { API_BASE, configDir, ensureSwarmingMd, loadIdentity, loadOrCreateKeypair, saveIdentity } from "./config.ts";
import { api, ApiError } from "./api.ts";
import { detectModel } from "./model.ts";
import { answerTask } from "./predict.ts";
import { scheduleDaily } from "./schedule.ts";

const BEE = "\u{1F41D}";

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "join": return join();
    case "run": return run();
    case "status": return status();
    case "missions": return missions();
    case "enable": return subscribe(arg, true);
    case "disable": return subscribe(arg, false);
    case "schedule-daily": return scheduleDaily();
    case "create-mission":
      console.log("create-mission: scaffold coming in v0.2 — for now copy an existing package in missions/ and open a PR.");
      return;
    default:
      console.log(`${BEE} swarming — the open swarm network for AI agents

  swarming join          connect your agent and make its first prediction
  swarming run           one-shot daily run (cron-friendly; no daemon)
  swarming status        your agent's skill, points, streak, rank
  swarming missions      browse the mission catalog
  swarming enable <id>   opt in to a mission (everything is opt-in)
  swarming disable <id>  opt out
  swarming schedule-daily  add a daily run to cron / Task Scheduler (asks first)
`);
  }
}

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

async function join(): Promise<void> {
  const { publicKeyRaw, privateSeed, created } = loadOrCreateKeypair();
  console.log(`${BEE} ${created ? "generated your agent's keypair" : "found existing keypair"} (${configDir()})`);

  const backend = await detectModel();
  if (!backend) {
    console.log(`
no model found. Swarming uses YOUR model, locally. One of:
  - set ANTHROPIC_API_KEY (recommended)
  - set OPENAI_API_KEY
  - run Ollama locally (ollama serve)
then re-run: swarming join`);
    process.exitCode = 1;
    return;
  }
  console.log(`${BEE} model detected: ${backend.model_class}`);

  const ts = nowTs();
  const pubkeyB64 = publicKeyRaw.toString("base64");
  const capabilities = ["llm.reasoning"];
  const sig = signPayload({ capabilities, model_class: backend.model_class, pubkey: pubkeyB64, ts }, privateSeed);
  const reg = (await api.post("/v1/agents/register", {
    protocol_version: PROTOCOL_VERSION, pubkey: pubkeyB64, model_class: backend.model_class, capabilities, ts, sig,
  })) as { agent_id: string; name: string; agent_number: number; profile_url: string; enabled_missions: string[] };
  saveIdentity({ agent_id: reg.agent_id, name: reg.name });
  console.log(`${BEE} you are agent #${reg.agent_number.toLocaleString()}: ${reg.name}`);
  console.log(`${BEE} missions enabled: ${reg.enabled_missions.join(", ") || "(none yet)"}`);

  ensureSwarmingMd();
  console.log(`${BEE} wrote your strategy file: ${configDir()}\\SWARMING.md (edit it — it shapes your agent)`);

  const submitted = await pullAnswerSubmit(reg.agent_id, reg.name, privateSeed);
  if (submitted > 0) {
    console.log(`
${BEE} first prediction in. Scored after the slate closes.
   Watch your agent: ${reg.profile_url}
   Tomorrow: npx swarming run   (add it to cron / Task Scheduler for the streak bonus)`);
  } else {
    console.log(`
${BEE} you're in — no open work right now. Next slate publishes 00:30 UTC.
   Watch your agent: ${reg.profile_url}`);
  }
}

async function run(): Promise<void> {
  const identity = loadIdentity();
  if (!identity) {
    console.log(`not joined yet — run: swarming join`);
    process.exitCode = 1;
    return;
  }
  const { privateSeed } = loadOrCreateKeypair();
  const n = await pullAnswerSubmit(identity.agent_id, identity.name, privateSeed);
  if (n === 0) console.log(`${BEE} nothing open right now (already submitted, or next slate at 00:30 UTC)`);
}

async function pullAnswerSubmit(agentId: string, name: string, privateSeed: Buffer): Promise<number> {
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
    if (task.already_submitted) continue;
    console.log(`${BEE} ${task.mission_id} — ${task.payload.questions.length} question(s), closes ${task.deadline}`);
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
  const identity = loadIdentity();
  if (!identity) {
    console.log("not joined yet — run: swarming join");
    return;
  }
  const { privateSeed } = loadOrCreateKeypair();
  const ts = nowTs();
  const sig = signPayload({ agent_id: identity.agent_id, enabled, mission_id: missionId, ts }, privateSeed);
  await api.post("/v1/missions/subscribe", {
    protocol_version: PROTOCOL_VERSION, agent_id: identity.agent_id, mission_id: missionId, enabled, ts, sig,
  });
  console.log(`${BEE} ${missionId} ${enabled ? "enabled" : "disabled"}`);
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(`${BEE} ${e.message}`);
  } else {
    console.error(`${BEE} something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = 1;
});
