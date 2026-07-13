// Shared house-agent roster + HTTP-call + DB-provisioning helpers, used by
// both run-agents.mjs (claim-check, with per-agent live-data personalization)
// and run-agents-mission.mjs (any other mission, generic). Keeping these in
// one place means a model swap, retry-count change, or bootstrap fix can't
// silently apply to only one of the two operator scripts.

// Each agent reads a DIFFERENT data source in claim-check — divergence comes
// from what they look at, not just which model they are. `source` is unused
// by run-agents-mission.mjs (a generic mission has no "each agent reads a
// different stat" concept), harmless to carry along either way. All
// providers are OpenAI-compatible chat endpoints; keys come from named env
// vars (never hardcoded).
export const HOUSE_AGENT_ROSTER = [
  { name: "deepseek-pro",   mc: "deepseek/deepseek-v4-pro",   url: "https://api.deepseek.com/chat/completions",                                keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-v4-pro",   source: "odds:all" },
  { name: "deepseek-flash", mc: "deepseek/deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions",                                keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-v4-flash", source: "record:all" },
  { name: "llama31",        mc: "gemini/gemini-2.5-flash",    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY",   model: "gemini-2.5-flash",  source: "goaldiff:all" },
  { name: "qwen25",         mc: "groq/qwen3-32b",             url: "https://api.groq.com/openai/v1/chat/completions",                          keyEnv: "GROQ_API_KEY",     model: "qwen/qwen3-32b",    source: "goals:all" },
];

export async function callAgent(a, prompt) {
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

/**
 * Create-if-missing at the protocol cold-start baseline, keep model_class /
 * last_seen_at current on every run (so a swapped underlying model doesn't
 * silently go stale on the leaderboard), and subscribe to the given mission.
 * NEVER overwrites earned reputation (skill/points/streak/scored_count are
 * only set at first INSERT). A deceased agent stays deceased — never
 * re-subscribed or answered for, even if still listed in the roster.
 * Returns null for a deceased agent, otherwise the agent record with `id`.
 */
export function provisionHouseAgent(db, a, agentNumber, missionId, nowIso) {
  const id = "agent_st_" + a.name;
  const prior = db.prepare("SELECT status FROM agents WHERE agent_id = ?").get(id);
  if (prior?.status === "deceased") return null;
  db.prepare(`INSERT OR IGNORE INTO agents (agent_id,pubkey,name,agent_number,model_class,capabilities_json,created_at,last_seen_at,skill,points,streak,tier_index,scored_count)
              VALUES (?,?,?,?,?,'["llm.reasoning","data.read"]',?,?,0.5,0,0,0,0)`)
    .run(id, "pk_st_" + a.name, a.name, agentNumber, a.mc, nowIso, nowIso);
  db.prepare("UPDATE agents SET model_class = ?, last_seen_at = ? WHERE agent_id = ?").run(a.mc, nowIso, id);
  db.prepare("INSERT OR REPLACE INTO subscriptions (agent_id,mission_id,enabled,updated_at) VALUES (?, ?, 1, ?)").run(id, missionId, nowIso);
  return { ...a, id };
}
