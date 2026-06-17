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
  {
    // wiki:<Page_Title> -> the page's summary extract (live encyclopedic context)
    match: /^wiki:(.+)$/,
    fetch: async (title) => {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
        signal: AbortSignal.timeout(6000),
        headers: { accept: "application/json" },
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { extract?: string };
      const x = (j.extract ?? "").trim();
      return x ? x.slice(0, 600) : null;
    },
  },
  {
    // wc:<A-L> -> live 2026 FIFA World Cup group standings from ESPN's public API (no key)
    match: /^wc:([A-La-l])$/,
    fetch: async (letter) => {
      const r = await fetch("https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings", { signal: AbortSignal.timeout(7000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { children?: { name?: string; standings?: { entries?: { team?: { displayName?: string }; stats?: { name: string; displayValue: string }[] }[] } }[] };
      const g = (j.children ?? []).find((c) => (c.name ?? "").toUpperCase() === `GROUP ${letter.toUpperCase()}`);
      const entries = g?.standings?.entries ?? [];
      if (entries.length === 0) return null;
      const rows = entries.map((e) => {
        const st = Object.fromEntries((e.stats ?? []).map((x) => [x.name, x.displayValue]));
        return `${st.rank ?? "?"}. ${e.team?.displayName ?? "?"} ${st.points ?? "0"}pts (${st.overall ?? ""})`;
      });
      return `${g?.name} live standings — ${rows.join("; ")}`;
    },
  },
  {
    // wc:all -> live current leader of every 2026 World Cup group (ESPN, no key)
    match: /^wc:all$/,
    fetch: async () => {
      const r = await fetch("https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings", { signal: AbortSignal.timeout(7000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { children?: { name?: string; standings?: { entries?: { team?: { displayName?: string }; stats?: { name: string; displayValue: string }[] }[] } }[] };
      const leaders = (j.children ?? []).map((g) => {
        const top = (g.standings?.entries ?? [])
          .map((e) => ({ name: e.team?.displayName, st: Object.fromEntries((e.stats ?? []).map((x) => [x.name, x.displayValue])) }))
          .sort((a, b) => Number(a.st.rank ?? 9) - Number(b.st.rank ?? 9))[0];
        return top ? `${g.name}: ${top.name} (${top.st.points ?? "0"}pts)` : null;
      }).filter(Boolean);
      return leaders.length ? "Live group leaders — " + leaders.join("; ") : null;
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
