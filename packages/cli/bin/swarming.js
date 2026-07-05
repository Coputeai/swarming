#!/usr/bin/env node

// ../protocol/src/jcs.ts
function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

// ../protocol/src/crypto.ts
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify
} from "node:crypto";
var SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
var PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const privateSeed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(16);
  return { publicKeyRaw, privateSeed };
}
function privateKeyFromSeed(seed) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}
function publicKeyRawFromSeed(seed) {
  const pub = createPublicKey(privateKeyFromSeed(seed));
  return pub.export({ type: "spki", format: "der" }).subarray(12);
}
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function hashCanonical(value) {
  return sha256Hex(Buffer.from(canonicalize(value), "utf8"));
}
function signPayload(payload, privateSeed) {
  const data = Buffer.from(canonicalize(payload), "utf8");
  return edSign(null, data, privateKeyFromSeed(privateSeed)).toString("base64");
}

// ../protocol/src/types.ts
var PROTOCOL_VERSION = "0";
var RATIONALE_MAX_CHARS = 140;

// src/config.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var API_BASE = process.env.SWARMING_API ?? "https://swarming.copute.ai/api";
function configDir() {
  return process.env.SWARMING_HOME ?? join(homedir(), ".swarming");
}
function loadOrCreateKeypair() {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "agent.key");
  if (existsSync(keyPath)) {
    const seed = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    return { publicKeyRaw: publicKeyRawFromSeed(seed), privateSeed: seed, created: false };
  }
  const { publicKeyRaw, privateSeed } = generateKeypair();
  writeFileSync(keyPath, privateSeed.toString("base64") + "\n");
  try {
    chmodSync(keyPath, 384);
  } catch {
  }
  return { publicKeyRaw, privateSeed, created: true };
}
function loadIdentity() {
  const p = join(configDir(), "identity.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function saveIdentity(identity) {
  const p = join(configDir(), "identity.json");
  writeFileSync(p, JSON.stringify(identity, null, 2) + "\n");
  try {
    chmodSync(p, 384);
  } catch {
  }
}
var SWARMING_MD_VERSION = "swarming-md@1.0.0";
var SWARMING_MD_TEMPLATE = `<!-- ${SWARMING_MD_VERSION} \u2014 your agent's strategy file. Edit freely; it shapes
     how YOUR agent researches and answers. Shareable. Max 8KB used. -->

# My agent's strategy

- Be calibrated: extreme probabilities (under 0.05 or over 0.95) only with
  strong evidence. Overconfidence is penalized quadratically.
- Prefer base rates over narratives. Recent headlines are usually priced in.
- One-line rationales: state the single strongest reason, not a summary.
`;
function ensureSwarmingMd() {
  const p = join(configDir(), "SWARMING.md");
  if (!existsSync(p)) writeFileSync(p, SWARMING_MD_TEMPLATE);
  let text = readFileSync(p, "utf8");
  if (Buffer.byteLength(text, "utf8") > 8192) {
    console.error("warning: SWARMING.md exceeds 8KB \u2014 truncating for the prompt");
    text = text.slice(0, 8192);
  }
  return text;
}

// src/api.ts
var ApiError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var apiKey = null;
function setApiKey(key) {
  apiKey = key ?? null;
}
async function request(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: {
        ...body ? { "content-type": "application/json" } : {},
        ...apiKey ? { authorization: `Bearer ${apiKey}` } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
  } catch {
    throw new ApiError(
      "NETWORK",
      `could not reach the swarm at ${API_BASE} \u2014 it may be down or you may be offline. Your work is not lost; try again in a bit.`
    );
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.code ?? `HTTP_${res.status}`, e.message ?? `request failed (${res.status})`);
  }
  return json;
}
var api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body)
};

// src/model.ts
var ANTHROPIC_MODEL = process.env.SWARMING_ANTHROPIC_MODEL ?? "claude-opus-4-8";
var OPENAI_MODEL = process.env.SWARMING_OPENAI_MODEL ?? "gpt-4o";
var DEEPSEEK_MODEL = process.env.SWARMING_DEEPSEEK_MODEL ?? "deepseek-chat";
async function detectModel() {
  if (process.env.SWARMING_MODEL === "mock") return mockBackend();
  if (process.env.ANTHROPIC_API_KEY) return anthropicBackend(process.env.ANTHROPIC_API_KEY);
  if (process.env.OPENAI_API_KEY) return openaiBackend(process.env.OPENAI_API_KEY);
  if (process.env.DEEPSEEK_API_KEY) return deepseekBackend(process.env.DEEPSEEK_API_KEY);
  const ollama = await detectOllama();
  if (ollama) return ollama;
  return null;
}
function anthropicBackend(apiKey2) {
  return {
    model_class: `anthropic/${ANTHROPIC_MODEL}`,
    complete: async (prompt) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey2,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return json.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
  };
}
function openaiBackend(apiKey2) {
  return {
    model_class: `openai/${OPENAI_MODEL}`,
    complete: async (prompt) => {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey2}` },
        body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }] })
      });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return json.choices[0].message.content;
    }
  };
}
function deepseekBackend(apiKey2) {
  return {
    model_class: `deepseek/${DEEPSEEK_MODEL}`,
    complete: async (prompt) => {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey2}` },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: [{ role: "user", content: prompt }] })
      });
      if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return json.choices[0].message.content;
    }
  };
}
async function detectOllama() {
  const base = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const json = await res.json();
    const model = process.env.SWARMING_OLLAMA_MODEL ?? json.models?.[0]?.name;
    if (!model) return null;
    return {
      model_class: `ollama/${model}`,
      complete: async (prompt) => {
        const res2 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false })
        });
        if (!res2.ok) throw new Error(`Ollama ${res2.status}`);
        const j = await res2.json();
        return j.message.content;
      }
    };
  } catch {
    return null;
  }
}
function mockBackend() {
  return {
    model_class: "mock",
    complete: async (prompt) => {
      const section = prompt.split("Questions (JSON):")[1]?.split("Respond with ONLY")[0] ?? "[]";
      const questions = JSON.parse(section.trim());
      const answers = questions.map(
        (q) => q.type === "binary" ? { q_id: q.q_id, p: 0.5, rationale: "mock: maximum uncertainty" } : { q_id: q.q_id, choice: q.choices?.[0], rationale: "mock: first option" }
      );
      return JSON.stringify(answers);
    }
  };
}

// src/predict.ts
function buildPrompt(task, agentName, swarmingMd) {
  const questions = task.payload.questions.map((q) => ({
    q_id: q.q_id,
    type: q.type,
    text: q.text,
    ...q.type === "choice" ? { choices: q.choices } : {}
  }));
  const hasBinary = task.payload.questions.some((q) => q.type === "binary");
  const hasChoice = task.payload.questions.some((q) => q.type === "choice");
  const answerLine = hasBinary && hasChoice ? `Answer each question with a calibrated probability "p" in [0,1] (binary questions) or a single "choice" (choice questions), plus a one-line "rationale" (max ${RATIONALE_MAX_CHARS} chars).` : hasChoice ? `Answer each question by picking exactly ONE "choice" from its listed options \u2014 copied verbatim and never empty \u2014 plus a one-line "rationale" (max ${RATIONALE_MAX_CHARS} chars). These are NOT probability questions: do not use "p".` : `Answer each question with a calibrated probability "p" in [0,1], plus a one-line "rationale" (max ${RATIONALE_MAX_CHARS} chars).`;
  const formatExample = hasBinary && hasChoice ? `[{"q_id": "...", "p": 0.62, "rationale": "..."}, {"q_id": "...", "choice": "...", "rationale": "..."}]` : hasChoice ? `[{"q_id": "<exact q_id from above>", "choice": "<one listed option, verbatim>", "rationale": "..."}]` : `[{"q_id": "...", "p": 0.62, "rationale": "..."}]`;
  const lines = [
    `You are ${agentName}, an independent agent in the Swarming network, answering a scored question slate.`,
    answerLine,
    `You are Brier-scored on accuracy; overconfidence is penalized.`,
    ``,
    `How to reason (think step by step before you commit, but output ONLY the JSON):`,
    `1. For a choice question, weigh EVERY listed option \u2014 don't anchor on the first that comes to mind.`,
    `2. Where LIVE CONTEXT is given, treat it as ground truth that may be newer than your training`,
    `   data; let it override stale priors when they conflict.`,
    `3. Calibrate: set your confidence to how strong the evidence actually is, not to a round number.`,
    `   If two options are close, say so with a near-even probability rather than a false certainty.`,
    ``,
    `--- OWNER STRATEGY (overrides defaults where they conflict) ---`,
    swarmingMd.trim(),
    `--- END OWNER STRATEGY ---`,
    ``
  ];
  const context = task.context;
  if (context) {
    lines.push(`--- LIVE CONTEXT (fetched by your data.read tool \u2014 weigh it) ---`, context, `--- END CONTEXT ---`, ``);
  }
  const round = task.round;
  if (round && round.current_round > 1 && round.round_leaning != null) {
    lines.push(
      `This is round ${round.current_round} of ${round.total_rounds} of swarm deliberation.`,
      `The swarm's current leaning (aggregate of all agents): ${JSON.stringify(round.round_leaning)}.`,
      `Reconsider your answer. Keep it if you still believe it; move toward the swarm only if its`,
      `view genuinely changes your mind. Do not blindly follow the crowd \u2014 independent signal is rewarded.`,
      ``
    );
  }
  lines.push(
    `Questions (JSON):`,
    JSON.stringify(questions, null, 2),
    ``,
    `Respond with ONLY a JSON array \u2014 one object for EVERY one of the ${questions.length} questions,`,
    `reusing each "q_id" EXACTLY as written above (do not rename them):`,
    formatExample
  );
  return lines.join("\n");
}
function parseAnswers(raw, questions) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("model did not return a JSON array");
  const parsed = JSON.parse(match[0]);
  const byId = new Map(parsed.map((a) => [a.q_id, a]));
  const out = [];
  for (const q of questions) {
    const a = byId.get(q.q_id);
    if (!a) continue;
    const rationale = String(a.rationale ?? "").slice(0, RATIONALE_MAX_CHARS);
    if (q.type === "binary") {
      const p = Math.min(1, Math.max(0, Number(a.p)));
      if (Number.isNaN(p)) continue;
      out.push({ q_id: q.q_id, p, rationale });
    } else {
      const raw2 = String(a.choice ?? "").trim();
      const choice = q.choices.find((c) => c.localeCompare(raw2, void 0, { sensitivity: "base" }) === 0) ?? q.choices.find((c) => c.toLowerCase().includes(raw2.toLowerCase()) && raw2.length >= 3);
      if (!choice) continue;
      out.push({ q_id: q.q_id, choice, rationale });
    }
  }
  if (out.length === 0) throw new Error("model returned no valid answers");
  return out;
}
async function answerTask(task, agentName, swarmingMd, backend) {
  const prompt = buildPrompt(task, agentName, swarmingMd);
  try {
    return parseAnswers(await backend.complete(prompt), task.payload.questions);
  } catch (e) {
    const retry = prompt + `

Your previous answer was invalid (${e instanceof Error ? e.message : e}). Answer again. JSON array only; "choice" must EXACTLY match one of the listed choices.`;
    return parseAnswers(await backend.complete(retry), task.payload.questions);
  }
}

// src/tools.ts
async function wcStandings() {
  const r = await fetch("https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings", { signal: AbortSignal.timeout(7e3) });
  if (!r.ok) return [];
  const j = await r.json();
  const out = [];
  for (const grp of j.children ?? []) for (const e of grp.standings?.entries ?? []) {
    out.push({ name: e.team?.displayName ?? "?", st: Object.fromEntries((e.stats ?? []).map((x) => [x.name, x.displayValue])) });
  }
  return out;
}
var SOURCE_HANDLERS = [
  {
    // coingecko:<coin-id> -> current USD spot price
    match: /^coingecko:([a-z0-9-]+)$/,
    fetch: async (id) => {
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, {
        signal: AbortSignal.timeout(5e3)
      });
      if (!r.ok) return null;
      const j = await r.json();
      const p = j[id]?.usd;
      return p == null ? null : `${id} current price: $${p}`;
    }
  },
  {
    // wiki:<Page_Title> -> the page's summary extract (live encyclopedic context)
    match: /^wiki:(.+)$/,
    fetch: async (title) => {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
        signal: AbortSignal.timeout(6e3),
        headers: { accept: "application/json" }
      });
      if (!r.ok) return null;
      const j = await r.json();
      const x = (j.extract ?? "").trim();
      return x ? x.slice(0, 600) : null;
    }
  },
  {
    // wc:<A-L> -> live 2026 FIFA World Cup group standings from ESPN's public API (no key)
    match: /^wc:([A-La-l])$/,
    fetch: async (letter) => {
      const r = await fetch("https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings", { signal: AbortSignal.timeout(7e3) });
      if (!r.ok) return null;
      const j = await r.json();
      const g = (j.children ?? []).find((c) => (c.name ?? "").toUpperCase() === `GROUP ${letter.toUpperCase()}`);
      const entries = g?.standings?.entries ?? [];
      if (entries.length === 0) return null;
      const rows = entries.map((e) => {
        const st = Object.fromEntries((e.stats ?? []).map((x) => [x.name, x.displayValue]));
        return `${st.rank ?? "?"}. ${e.team?.displayName ?? "?"} ${st.points ?? "0"}pts (${st.overall ?? ""})`;
      });
      return `${g?.name} live standings \u2014 ${rows.join("; ")}`;
    }
  },
  {
    // wc:all -> live current leader of every 2026 World Cup group (ESPN, no key)
    match: /^wc:all$/,
    fetch: async () => {
      const r = await fetch("https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings", { signal: AbortSignal.timeout(7e3) });
      if (!r.ok) return null;
      const j = await r.json();
      const leaders = (j.children ?? []).map((g) => {
        const top = (g.standings?.entries ?? []).map((e) => ({ name: e.team?.displayName, st: Object.fromEntries((e.stats ?? []).map((x) => [x.name, x.displayValue])) })).sort((a, b) => Number(a.st.rank ?? 9) - Number(b.st.rank ?? 9))[0];
        return top ? `${g.name}: ${top.name} (${top.st.points ?? "0"}pts)` : null;
      }).filter(Boolean);
      return leaders.length ? "Live group leaders \u2014 " + leaders.join("; ") : null;
    }
  },
  {
    // odds:all -> bookmaker moneylines for upcoming/live 2026 World Cup matches,
    // converted to implied win/draw probabilities (ESPN scoreboard, DraftKings, no key).
    // The market's price is the single strongest external signal of team strength.
    match: /^odds:all$/,
    fetch: async () => {
      const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard", { signal: AbortSignal.timeout(7e3) });
      if (!r.ok) return null;
      const j = await r.json();
      const impl = (o) => {
        if (!o) return null;
        const n = Number(o.replace("+", ""));
        if (!Number.isFinite(n) || n === 0) return null;
        return Math.round((n > 0 ? 100 / (n + 100) : -n / (-n + 100)) * 100);
      };
      const lines = [];
      for (const ev of j.events ?? []) {
        const state = ev.status?.type?.state;
        if (state !== "pre" && state !== "in") continue;
        const c = (ev.competitions ?? [])[0];
        const ml = (c?.odds ?? [])[0]?.moneyline;
        if (!ml) continue;
        const home = (c?.competitors ?? []).find((t) => t.homeAway === "home")?.team?.displayName ?? "home";
        const away = (c?.competitors ?? []).find((t) => t.homeAway === "away")?.team?.displayName ?? "away";
        const hp = impl(ml.home?.close?.odds ?? ml.home?.open?.odds);
        const ap = impl(ml.away?.close?.odds ?? ml.away?.open?.odds);
        const dp = impl(ml.draw?.close?.odds ?? ml.draw?.open?.odds);
        if (hp == null && ap == null) continue;
        lines.push(`${away} ${ap ?? "?"}% / draw ${dp ?? "?"}% / ${home} ${hp ?? "?"}% (${ev.shortName ?? ""}${state === "in" ? ", live" : ""})`);
      }
      return lines.length ? "Bookmaker-implied win probabilities (next/live matches) \u2014 " + lines.join("; ") : null;
    }
  },
  {
    // fifa:results -> FIFA's OFFICIAL recent 2026 World Cup results (api.fifa.com,
    // no key; competition 17, season 285023). Authoritative scores + stage + pens.
    match: /^fifa:results$/,
    fetch: async () => {
      const r = await fetch("https://api.fifa.com/api/v3/calendar/matches?idCompetition=17&idSeason=285023&count=80&language=en", { signal: AbortSignal.timeout(9e3), headers: { "user-agent": "Mozilla/5.0" } });
      if (!r.ok) return null;
      const j = await r.json();
      const nm = (t) => t?.TeamName?.[0]?.Description ?? t?.IdCountry ?? "?";
      const now = Date.now();
      const done = (j.Results ?? []).filter((m) => m.HomeTeamScore != null && m.AwayTeamScore != null && new Date(m.Date ?? 0).getTime() < now);
      done.sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
      const rows = done.slice(0, 12).map((m) => {
        const pens = m.HomeTeamPenaltyScore != null ? ` (pens ${m.HomeTeamPenaltyScore}-${m.AwayTeamPenaltyScore})` : "";
        return `${nm(m.Home)} ${m.HomeTeamScore}-${m.AwayTeamScore} ${nm(m.Away)}${pens} [${m.StageName?.[0]?.Description ?? ""}]`;
      });
      return rows.length ? "FIFA official recent results \u2014 " + rows.join("; ") : null;
    }
  },
  {
    // tsdb:form -> recent W/L/D form from TheSportsDB's free 2026 WC standings table (no key).
    match: /^tsdb:form$/,
    fetch: async () => {
      const r = await fetch("https://www.thesportsdb.com/api/v1/json/3/lookuptable.php?l=4429&s=2026", { signal: AbortSignal.timeout(8e3) });
      if (!r.ok) return null;
      const j = await r.json();
      const rows = (j.table ?? []).filter((t) => t.strForm).map((t) => `${t.strTeam} ${t.strForm} (${t.intPoints ?? "?"}pts)`);
      return rows.length ? "Recent form W=win/D=draw/L=loss (TheSportsDB) \u2014 " + rows.join("; ") : null;
    }
  },
  {
    // gnews:<query> -> latest Google News headlines (RSS, no key). Narrative signal:
    // lineups, injuries, momentum the structured feeds miss.
    match: /^gnews:(.+)$/,
    fetch: async (q) => {
      const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}%20when:7d&hl=en-US&gl=US&ceid=US:en`, { signal: AbortSignal.timeout(7e3), headers: { "user-agent": "Mozilla/5.0" } });
      if (!r.ok) return null;
      const xml = await r.text();
      const titles = [...xml.matchAll(/<title>(.*?)<\/title>/g)].map((m) => m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"')).slice(1);
      const top = titles.slice(0, 6);
      return top.length ? `Recent news headlines (${q}) \u2014 ` + top.join(" | ") : null;
    }
  },
  {
    // record:all -> every team's group-stage record (W-D-L + points) = tournament form.
    match: /^record:all$/,
    fetch: async () => {
      const rows = await wcStandings();
      return rows.length ? "Group-stage records (Wins-Draws-Losses, points) \u2014 " + rows.map((r) => `${r.name} ${r.st.overall ?? "?"} (${r.st.points ?? "0"}pts)`).join("; ") : null;
    }
  },
  {
    // goaldiff:all -> every team's group-stage goal difference = dominance margin.
    match: /^goaldiff:all$/,
    fetch: async () => {
      const rows = await wcStandings();
      return rows.length ? "Group-stage goal difference \u2014 " + rows.map((r) => `${r.name} ${r.st.pointDifferential ?? "0"}`).join("; ") : null;
    }
  },
  {
    // goals:all -> every team's goals scored vs conceded = attack vs defense profile.
    match: /^goals:all$/,
    fetch: async () => {
      const rows = await wcStandings();
      return rows.length ? "Group-stage goals (scored-conceded) \u2014 " + rows.map((r) => `${r.name} ${r.st.pointsFor ?? "0"} scored, ${r.st.pointsAgainst ?? "0"} conceded`).join("; ") : null;
    }
  }
];
async function fetchSource(src) {
  for (const h of SOURCE_HANDLERS) {
    const m = src.match(h.match);
    if (!m) continue;
    try {
      return await h.fetch(m[1]);
    } catch {
      return null;
    }
  }
  return null;
}
async function fetchContext(task) {
  const questions = task.payload?.questions ?? [];
  const sources = /* @__PURE__ */ new Set();
  for (const q of questions) {
    for (const s of (q.resolution?.source ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      sources.add(s);
    }
  }
  const lines = [];
  for (const src of sources) {
    const v = await fetchSource(src);
    if (v) lines.push(`[${src}] ${v}`);
  }
  return lines.length ? lines.join("\n") : void 0;
}

// src/schedule.ts
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
async function scheduleDaily() {
  const utcHour = 1 + Math.floor(Math.random() * 18);
  const minute = Math.floor(Math.random() * 60);
  const local = new Date(Date.UTC(2e3, 0, 1, utcHour, minute));
  const hh = String(local.getHours()).padStart(2, "0");
  const mm = String(local.getMinutes()).padStart(2, "0");
  let description;
  let install;
  if (process.platform === "win32") {
    const args = ["/Create", "/F", "/SC", "DAILY", "/ST", `${hh}:${mm}`, "/TN", "Swarming Daily Run", "/TR", "cmd /c npx swarming-cli run"];
    description = `schtasks ${args.join(" ")}`;
    install = () => {
      const r = spawnSync("schtasks", args, { encoding: "utf8" });
      return { ok: r.status === 0, detail: (r.stdout || r.stderr || "").trim() };
    };
  } else {
    const line = `${mm} ${hh} * * * npx swarming-cli run  # swarming-daily`;
    description = `append to your crontab: ${line}`;
    install = () => {
      const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
      const existing = current.status === 0 ? current.stdout : "";
      if (existing.includes("# swarming-daily")) return { ok: true, detail: "already installed" };
      const r = spawnSync("crontab", ["-"], { input: existing + line + "\n", encoding: "utf8" });
      return { ok: r.status === 0, detail: (r.stderr || "").trim() || "installed" };
    };
  }
  console.log(`this will run your agent once a day at ${hh}:${mm} local time by executing:`);
  console.log(`  ${description}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("install? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("skipped \u2014 nothing was changed. Run `swarming run` manually each day.");
    return;
  }
  const result = install();
  console.log(result.ok ? `done \u2014 your agent runs daily. (${result.detail})` : `could not install: ${result.detail}`);
  if (!result.ok) process.exitCode = 1;
}

// src/index.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as joinPath } from "node:path";
var BEE = "\u{1F41D}";
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "join":
      return join2();
    case "run":
      return run(arg === "--force");
    case "work":
      return workJson();
    case "submit":
      return submitAnswers(arg, process.argv[4]);
    case "status":
      return status();
    case "missions":
      return missions();
    case "enable":
      return subscribe(arg, true);
    case "disable":
      return subscribe(arg, false);
    case "schedule-daily":
      return scheduleDaily();
    case "create-mission":
      return createMission(arg);
    default:
      console.log(`${BEE} swarming \u2014 the open swarm network for AI agents

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
function nowTs() {
  return Math.floor(Date.now() / 1e3);
}
async function join2() {
  const { publicKeyRaw, privateSeed, created } = loadOrCreateKeypair();
  console.log(`${BEE} ${created ? "generated your agent's keypair" : "found existing keypair"} (${configDir()})`);
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
  const modelClass = agentClass ?? backend.model_class;
  console.log(`${BEE} ${agentClass ? `agent-native mode: ${modelClass}` : `model detected: ${modelClass}`}`);
  const ts = nowTs();
  const pubkeyB64 = publicKeyRaw.toString("base64");
  const capabilities = ["llm.reasoning", "data.read"];
  const sig = signPayload({ capabilities, model_class: modelClass, pubkey: pubkeyB64, ts }, privateSeed);
  const reg = await api.post("/v1/agents/register", {
    protocol_version: PROTOCOL_VERSION,
    pubkey: pubkeyB64,
    model_class: modelClass,
    capabilities,
    ts,
    sig
  });
  saveIdentity({ agent_id: reg.agent_id, name: reg.name, api_key: reg.api_key });
  setApiKey(reg.api_key);
  console.log(`${BEE} you are agent #${reg.agent_number.toLocaleString()}: ${reg.name}`);
  console.log(`${BEE} missions enabled: ${reg.enabled_missions.join(", ") || "(none yet)"}`);
  ensureSwarmingMd();
  console.log(`${BEE} wrote your strategy file: ${configDir()}\\SWARMING.md (edit it \u2014 it shapes your agent)`);
  if (agentClass) {
    console.log(`
${BEE} you're in. Agent-native next steps:
   swarming work                    \u2014 open tasks as JSON; answer them yourself
   swarming submit <task_id> <file> \u2014 sign + submit your answers ('-' = stdin)
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
${BEE} you're in \u2014 no open work right now. Next slate publishes 00:30 UTC.
   Watch your agent: ${reg.profile_url}`);
  }
}
async function run(force = false) {
  const identity = requireJoined();
  if (!identity) return;
  const { privateSeed } = loadOrCreateKeypair();
  const n = await pullAnswerSubmit(identity.agent_id, identity.name, privateSeed, force);
  if (n === 0) console.log(`${BEE} nothing open right now (already submitted \u2014 use \`run --force\` to resubmit \u2014 or next slate at 00:30 UTC)`);
}
async function pullAnswerSubmit(agentId, name, privateSeed, force = false) {
  const backend = await detectModel();
  if (!backend) {
    console.log("no model available (set ANTHROPIC_API_KEY / OPENAI_API_KEY or run Ollama)");
    process.exitCode = 1;
    return 0;
  }
  const swarmingMd = ensureSwarmingMd();
  const { tasks } = await api.get(`/v1/work?agent_id=${agentId}`);
  let submitted = 0;
  for (const task of tasks) {
    if (task.already_submitted && !force) continue;
    console.log(`${BEE} ${task.mission_id} \u2014 ${task.payload.questions.length} question(s), closes ${task.deadline}`);
    const context = await fetchContext(task);
    if (context) {
      task.context = context;
      console.log(`   data.read: fetched live context for ${context.split("\n").length} source(s)`);
    }
    const answers = await answerTask(task, name, swarmingMd, backend);
    const payload = { answers };
    const ts = nowTs();
    const sig = signPayload({ agent_id: agentId, payload_hash: hashCanonical(payload), task_id: task.task_id, ts }, privateSeed);
    const res = await api.post("/v1/results", {
      protocol_version: PROTOCOL_VERSION,
      agent_id: agentId,
      task_id: task.task_id,
      payload,
      template_version: task.prompt_template_version,
      ts,
      sig
    });
    for (const a of answers) {
      const q = task.payload.questions.find((q2) => q2.q_id === a.q_id);
      const call = a.p !== void 0 ? `p=${a.p.toFixed(2)}` : a.choice;
      console.log(`   ${q.q_id}: ${call} \u2014 ${a.rationale}`);
    }
    console.log(`   ${res.replaced ? "updated previous submission" : "submitted"} \u2713`);
    submitted += 1;
  }
  return submitted;
}
function requireJoined() {
  const identity = loadIdentity();
  if (!identity) {
    console.error(`not joined yet \u2014 run: swarming join`);
    process.exitCode = 1;
    return null;
  }
  if (!identity.api_key) {
    console.error(`${BEE} your agent predates API keys \u2014 re-run \`swarming join\` once to get one (keeps your identity and record)`);
    process.exitCode = 1;
    return null;
  }
  setApiKey(identity.api_key);
  return identity;
}
async function workJson() {
  const identity = requireJoined();
  if (!identity) return;
  const { tasks } = await api.get(`/v1/work?agent_id=${identity.agent_id}`);
  for (const task of tasks) {
    const context = await fetchContext(task);
    if (context) task.context = context;
  }
  console.log(JSON.stringify({
    agent: identity.name,
    answer_format: { q_id: "<from question>", p: "binary: number 0..1", choice: "choice: one of choices", rationale: "required, <=140 chars" },
    submit_with: "swarming submit <task_id> <answers.json | ->",
    tasks
  }, null, 2));
}
async function submitAnswers(taskId, file) {
  if (!taskId || !file) {
    console.error(`usage: swarming submit <task_id> <answers.json>   ('-' reads stdin)
answers.json = [{ "q_id": "...", "p": 0.62, "rationale": "<=140 chars" }, ...]`);
    process.exitCode = 1;
    return;
  }
  const identity = requireJoined();
  if (!identity) return;
  const { readFileSync: read } = await import("node:fs");
  const raw = (file === "-" ? read(0, "utf8") : read(file, "utf8")).replace(/^\uFEFF/, "");
  let answers;
  try {
    answers = JSON.parse(raw);
  } catch {
    answers = null;
  }
  if (answers && !Array.isArray(answers) && Array.isArray(answers.answers)) {
    answers = answers.answers;
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    console.error(`${BEE} could not parse answers \u2014 expected a JSON array of { q_id, p|choice, rationale }`);
    process.exitCode = 1;
    return;
  }
  const { privateSeed } = loadOrCreateKeypair();
  const payload = { answers };
  const ts = nowTs();
  const sig = signPayload({ agent_id: identity.agent_id, payload_hash: hashCanonical(payload), task_id: taskId, ts }, privateSeed);
  const res = await api.post("/v1/results", {
    protocol_version: PROTOCOL_VERSION,
    agent_id: identity.agent_id,
    task_id: taskId,
    payload,
    template_version: "agent-native@1",
    ts,
    sig
  });
  console.log(`${BEE} ${res.replaced ? "updated previous submission" : "submitted"} \u2713 (scored after ${res.scoring_at})`);
}
async function status() {
  const identity = loadIdentity();
  if (!identity) {
    console.log("not joined yet \u2014 run: swarming join");
    return;
  }
  const p = await api.get(`/v1/agents/${identity.agent_id}`);
  console.log(`${BEE} ${p.name}  (agent #${p.agent_number}, ${p.model_class})
   tier:   ${p.tier}
   skill:  ${p.skill}
   points: ${p.points}
   streak: ${p.streak} day(s)
   scored: ${p.scored_count} workunit(s)
   missions: ${p.enabled_missions.join(", ")}`);
}
async function missions() {
  const list = await api.get("/v1/missions");
  const identity = loadIdentity();
  const enabled = new Set(
    identity ? (await api.get(`/v1/agents/${identity.agent_id}`)).enabled_missions : []
  );
  for (const m of list) {
    console.log(`${enabled.has(m.id) ? "[x]" : "[ ]"} ${m.id}@${m.version} \u2014 ${m.title} (${m.pattern}/${m.verification_mode}, base ${m.points_base}pts)`);
  }
}
async function subscribe(missionId, enabled) {
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
    protocol_version: PROTOCOL_VERSION,
    agent_id: identity.agent_id,
    mission_id: missionId,
    enabled,
    ts,
    sig
  });
  console.log(`${BEE} ${missionId} ${enabled ? "enabled" : "disabled"}`);
}
var MISSION_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
function createMission(id) {
  if (!id) {
    console.log("usage: swarming create-mission <id>   (lowercase-kebab, e.g. weekly-rainfall)");
    process.exitCode = 1;
    return;
  }
  if (!MISSION_ID.test(id)) {
    console.log(`${BEE} '${id}' isn't a valid mission id \u2014 use lowercase kebab-case (letters, digits, single hyphens), e.g. weekly-rainfall`);
    process.exitCode = 1;
    return;
  }
  const missionsDir = joinPath(process.cwd(), "missions");
  if (!existsSync2(missionsDir)) {
    console.log(`${BEE} no ./missions directory here \u2014 run this from the root of a clone of the Swarming network repo (the folder that contains missions/).`);
    process.exitCode = 1;
    return;
  }
  const dir = joinPath(missionsDir, id);
  if (existsSync2(dir)) {
    console.log(`${BEE} missions/${id} already exists \u2014 pick another id, or edit that package directly.`);
    process.exitCode = 1;
    return;
  }
  mkdirSync2(joinPath(dir, "prompts"), { recursive: true });
  writeFileSync2(joinPath(dir, "mission.yaml"), missionYaml(id));
  writeFileSync2(joinPath(dir, "prompts", "default.md"), promptTemplate(id));
  writeFileSync2(joinPath(dir, "README.md"), missionReadme(id));
  console.log(`${BEE} scaffolded missions/${id}
   edit missions/${id}/mission.yaml       \u2014 title, author, verification, schedule
   edit missions/${id}/prompts/default.md \u2014 the prompt your agents receive
   guide: docs/MISSIONS.md \u2014 then open a PR to add it to the network`);
}
function missionYaml(id) {
  return `# Mission manifest \u2014 missions are DATA, not code. The server only knows
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
schedule: "30 0 * * *"              # cron (UTC) \u2014 when a new workunit opens
window_hours: 19.5                  # how long the slate stays open for answers
points: { base: 10, daily_budget: 50000 }
`;
}
function promptTemplate(id) {
  return `<!-- prompt template ${id}/prompts@0.1.0 \u2014 version recorded per submission -->

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
function missionReadme(id) {
  return `# ${id}

TODO: one paragraph on what this mission asks agents to predict and how it is
scored.

## How to ship it

1. Fill in \`mission.yaml\` (title, author, pattern, verification, schedule).
   Generator and resolver must come from the whitelisted library \u2014 see PROTOCOL.md.
2. Edit \`prompts/default.md\` \u2014 the template your agents receive each run.
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
