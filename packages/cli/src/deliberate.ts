// `swarming deliberate` — run N local Ollama models through the swarm's real
// deliberation engine (blind answers -> leaning shared -> reconsider rounds
// -> cross-inhibition verdict/abstention), fully offline, zero server
// interaction. Same engine as the network: this file never reimplements the
// consensus math, it only calls deliberate() from swarming-consensus.
//
// BINARY-ONLY v1: each model answers a single yes/no question with a
// calibrated p (0..1 = probability of YES) plus a one-line rationale.

import { deliberate, type AgentContext, type AgentResponse, type DeliberatingAgent, type Leaning } from "../../consensus/src/index.ts";
import { RATIONALE_MAX_CHARS } from "../../protocol/src/index.ts";
import { ollamaChat } from "./model.ts";

const BEE = "\u{1F41D}";

interface ParsedArgs {
  question?: string;
  models: string[];
  rounds: number;
  quorum?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let question: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i] ?? "";
    } else if (question === undefined) {
      question = a;
    }
  }
  const models = (flags.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rounds = flags.rounds ? Math.max(1, Math.floor(Number(flags.rounds)) || 3) : 3;
  const quorum = flags.quorum !== undefined ? Number(flags.quorum) : undefined;
  return { question, models, rounds, quorum };
}

function usage(): void {
  console.log(`usage: swarming deliberate "<question>" --models a,b[,c...] [--rounds N] [--quorum X]

Runs local Ollama models through the swarm's real deliberation engine — blind
answers, leaning shared back, reconsider rounds, cross-inhibition verdict —
fully offline, no server involved. Requires Ollama running locally
(ollama serve) with the given model tags pulled.

example:
  swarming deliberate "will it rain in SF tomorrow?" --models llama3.2,qwen2.5`);
}

// Extracts the first balanced {...} block from prose a model wraps its JSON in.
function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in model output");
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced JSON object in model output");
}

function parseResponse(raw: string): AgentResponse {
  const obj = JSON.parse(extractJsonObject(raw)) as { p?: unknown; rationale?: unknown };
  const p = Number(obj.p);
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`"p" must be a number in [0,1]`);
  const rationale = String(obj.rationale ?? "").slice(0, RATIONALE_MAX_CHARS);
  // The wire format is just {p, rationale} — confidence isn't asked of the
  // model directly (binary-only v1), so derive it from how far p sits from
  // a coin flip: it's only used for the transcript display, never for scoring.
  const confidence = Math.abs(p - 0.5) * 2;
  return { answer: p, confidence, rationale };
}

function buildPrompt(tag: string, ctx: AgentContext): string {
  const lines = [
    `You are ${tag}, one independent model in a local swarm of Ollama models deliberating over a single yes/no question.`,
    `Answer with a calibrated probability "p" in [0,1] that the answer is YES, plus a one-line "rationale" (max ${RATIONALE_MAX_CHARS} chars).`,
    `You are not scored here — this is a local, offline run — but calibrate honestly: overconfidence`,
    `(p under 0.05 or over 0.95 without strong evidence) is a bad look.`,
    ``,
  ];
  const leaning = ctx.leaning;
  if (ctx.round > 1 && leaning && "yes" in leaning && leaning.yes != null) {
    lines.push(
      `This is round ${ctx.round} of swarm deliberation.`,
      `The swarm's current leaning (aggregate p-yes across all models so far): ${leaning.yes.toFixed(2)}.`,
      `Reconsider your answer. Keep it if you still believe it; move toward the swarm only if its`,
      `view genuinely changes your mind. Do not blindly follow the crowd — independent signal is rewarded.`,
      ``,
    );
  }
  lines.push(
    `Question: ${ctx.question}`,
    ``,
    `Respond with ONLY a JSON object, nothing else:`,
    `{"p": 0.62, "rationale": "..."}`,
  );
  return lines.join("\n");
}

async function callModel(tag: string, ctx: AgentContext): Promise<AgentResponse> {
  const prompt = buildPrompt(tag, ctx);
  try {
    return parseResponse(await ollamaChat(tag, prompt));
  } catch (e) {
    // one retry with the error fed back — same retry philosophy as predict.ts
    const retry = prompt + `\n\nYour previous reply was invalid (${e instanceof Error ? e.message : e}). ` +
      `Reply again with ONLY the JSON object: {"p": <number 0..1>, "rationale": "<=140 chars"}.`;
    try {
      return parseResponse(await ollamaChat(tag, retry));
    } catch {
      throw new Error(`${tag} failed to answer`);
    }
  }
}

// Wraps a pre-validated (preflight-probed) model as a DeliberatingAgent.
// Round 1 reuses the preflight answer instead of calling the model again —
// deliberate()'s own round 1 is otherwise identical to the probe call.
function wrapAgent(tag: string, cachedRound1: AgentResponse, leaningByRound: Map<number, Leaning | undefined>): DeliberatingAgent {
  return async (ctx: AgentContext) => {
    if (!leaningByRound.has(ctx.round)) leaningByRound.set(ctx.round, ctx.leaning);
    if (ctx.round === 1) return cachedRound1;
    return callModel(tag, ctx);
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export async function runDeliberate(argv: string[]): Promise<void> {
  const { question, models, rounds, quorum } = parseArgs(argv);
  if (!question) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (models.length < 2) {
    console.log(`${BEE} a swarm of one is just an opinion — pass at least 2 models, e.g. --models llama3.2,qwen2.5`);
    process.exitCode = 1;
    return;
  }

  console.log(`${BEE} deliberating: "${question}"`);
  console.log(`${BEE} panel: ${models.join(", ")}  (${rounds} round(s), offline, no server involved)`);
  console.log("");

  // Preflight: validate every model can actually answer before committing to
  // a full deliberate() run (its rounds are all-or-nothing per call).
  const probes = await Promise.allSettled(models.map((tag) => callModel(tag, { question, round: 1 })));
  const ready: { tag: string; r: AgentResponse }[] = [];
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    if (p.status === "fulfilled") ready.push({ tag: models[i], r: p.value });
    else console.log(`${BEE} ${models[i]} failed to answer`);
  }
  if (ready.length < 2) {
    console.error(`${BEE} fewer than 2 models answered (${ready.length} succeeded) — need at least 2 to deliberate.`);
    process.exitCode = 1;
    return;
  }

  const leaningByRound = new Map<number, Leaning | undefined>();
  const agents = ready.map(({ tag, r }) => wrapAgent(tag, r, leaningByRound));

  let verdict;
  try {
    verdict = await deliberate({ question, agents, rounds, quorum });
  } catch (e) {
    console.error(`${BEE} deliberation failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  for (let round = 1; round <= verdict.rounds; round++) {
    console.log(`${BEE} round ${round}:`);
    for (const t of verdict.transcript.filter((t) => t.round === round)) {
      const tag = ready[t.agent].tag;
      const p = typeof t.answer === "number" ? t.answer.toFixed(2) : String(t.answer);
      console.log(`   ${tag}: p=${p}  — ${t.rationale ?? ""}`);
    }
    if (round < verdict.rounds) {
      const leaning = leaningByRound.get(round + 1);
      if (leaning && "yes" in leaning && leaning.yes != null) {
        console.log(`   swarm leaning after round ${round}: p-yes ≈ ${leaning.yes.toFixed(2)}`);
      }
    }
    console.log("");
  }

  const bigClusters = verdict.clusters.filter((c) => c.members.length > 1);
  for (const c of bigClusters) {
    const names = c.members.map((i) => ready[i].tag).join(", ");
    console.log(`${BEE} ${c.members.length} models answered near-identically — they share one voice: ${names}`);
  }

  const side = verdict.answer === 1 ? "YES" : verdict.answer === 0 ? "NO" : "no leaning";
  if (verdict.committed) {
    console.log(`${BEE} COMMITTED — ${side}  (confidence ${pct(verdict.confidence)})`);
  } else {
    console.log(`${BEE} ABSTAINED — no quorum reached (honest, not a failure). Leaning: ${side} (${pct(verdict.confidence)}) — this is a leaning, not a verdict.`);
  }
  console.log(`${BEE} same engine as the network: swarming-consensus. Try it live: npx swarming-cli join`);
}
