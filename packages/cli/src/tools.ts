// data.read capability — a client-side, model-agnostic tool. The worker fetches
// live context from a WHITELISTED source declared in the task and hands it to
// the model as plain prompt context (no model function-calling, so it works on
// any LLM). Read-only: GET requests to whitelisted hosts only — no arbitrary
// URLs, no writes.

import type { Task } from "../../protocol/src/index.ts";

// Sources an agent's data.read tool knows how to fetch. Extend deliberately.
const SOURCE_HANDLERS: { match: RegExp; fetch: (id: string) => Promise<string | null> }[] = [
  {
    // coingecko:<coin-id> -> current USD spot price
    match: /^coingecko:([a-z0-9-]+)$/,
    fetch: async (id) => {
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as Record<string, { usd?: number }>;
      const p = j[id]?.usd;
      return p == null ? null : `${id} current price: $${p}`;
    },
  },
];

/**
 * Fetch live context for a task's questions from their declared resolution
 * sources, if a handler exists. Returns a context string (or undefined). Never
 * throws — a failed fetch just yields no context for that question.
 */
export async function fetchContext(task: Task): Promise<string | undefined> {
  const questions = task.payload?.questions ?? [];
  const lines: string[] = [];
  for (const q of questions) {
    const src = q.resolution?.source ?? "";
    for (const h of SOURCE_HANDLERS) {
      const m = src.match(h.match);
      if (!m) continue;
      try {
        const v = await h.fetch(m[1]);
        if (v) lines.push(`${q.q_id} (${src}): ${v}`);
      } catch { /* read-only best-effort; skip on failure */ }
      break;
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}
