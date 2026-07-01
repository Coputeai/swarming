// data.read capability — a client-side, model-agnostic tool. The worker fetches
// live context from a WHITELISTED source declared in the task and hands it to
// the model as plain prompt context (no model function-calling, so it works on
// any LLM). Read-only: GET requests to whitelisted hosts only — no arbitrary
// URLs, no writes.

import type { Task } from "../../protocol/src/index.ts";

// Shared fetch of the live 2026 World Cup group-stage standings (ESPN, no key).
// Each team comes back with its raw stat map (overall W-D-L, points, goals for/
// against, goal differential). Three sources below format different angles of it,
// all with full coverage of every team still in the tournament.
async function wcStandings(): Promise<{ name: string; st: Record<string, string> }[]> {
  const r = await fetch("https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings", { signal: AbortSignal.timeout(7000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { children?: { standings?: { entries?: { team?: { displayName?: string }; stats?: { name: string; displayValue: string }[] }[] } }[] };
  const out: { name: string; st: Record<string, string> }[] = [];
  for (const grp of j.children ?? []) for (const e of grp.standings?.entries ?? []) {
    out.push({ name: e.team?.displayName ?? "?", st: Object.fromEntries((e.stats ?? []).map((x) => [x.name, x.displayValue])) });
  }
  return out;
}

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
  {
    // odds:all -> bookmaker moneylines for upcoming/live 2026 World Cup matches,
    // converted to implied win/draw probabilities (ESPN scoreboard, DraftKings, no key).
    // The market's price is the single strongest external signal of team strength.
    match: /^odds:all$/,
    fetch: async () => {
      const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard", { signal: AbortSignal.timeout(7000) });
      if (!r.ok) return null;
      type Side = { close?: { odds?: string }; open?: { odds?: string } };
      type Ev = { shortName?: string; status?: { type?: { state?: string } }; competitions?: { competitors?: { homeAway?: string; team?: { displayName?: string } }[]; odds?: { provider?: { name?: string }; moneyline?: { home?: Side; away?: Side; draw?: Side } }[] }[] };
      const j = (await r.json()) as { events?: Ev[] };
      // American moneyline -> implied probability (incl. bookmaker margin), as a percent.
      const impl = (o?: string): number | null => {
        if (!o) return null;
        const n = Number(o.replace("+", ""));
        if (!Number.isFinite(n) || n === 0) return null;
        return Math.round((n > 0 ? 100 / (n + 100) : -n / (-n + 100)) * 100);
      };
      const lines: string[] = [];
      for (const ev of (j.events ?? [])) {
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
      return lines.length ? "Bookmaker-implied win probabilities (next/live matches) — " + lines.join("; ") : null;
    },
  },
  {
    // fifa:results -> FIFA's OFFICIAL recent 2026 World Cup results (api.fifa.com,
    // no key; competition 17, season 285023). Authoritative scores + stage + pens.
    match: /^fifa:results$/,
    fetch: async () => {
      const r = await fetch("https://api.fifa.com/api/v3/calendar/matches?idCompetition=17&idSeason=285023&count=80&language=en", { signal: AbortSignal.timeout(9000), headers: { "user-agent": "Mozilla/5.0" } });
      if (!r.ok) return null;
      type Team = { TeamName?: { Description?: string }[]; IdCountry?: string };
      type M = { Date?: string; HomeTeamScore?: number | null; AwayTeamScore?: number | null; HomeTeamPenaltyScore?: number | null; AwayTeamPenaltyScore?: number | null; Home?: Team; Away?: Team; StageName?: { Description?: string }[] };
      const j = (await r.json()) as { Results?: M[] };
      const nm = (t?: Team) => t?.TeamName?.[0]?.Description ?? t?.IdCountry ?? "?";
      const now = Date.now();
      const done = (j.Results ?? []).filter((m) => m.HomeTeamScore != null && m.AwayTeamScore != null && new Date(m.Date ?? 0).getTime() < now);
      done.sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
      const rows = done.slice(0, 12).map((m) => {
        const pens = m.HomeTeamPenaltyScore != null ? ` (pens ${m.HomeTeamPenaltyScore}-${m.AwayTeamPenaltyScore})` : "";
        return `${nm(m.Home)} ${m.HomeTeamScore}-${m.AwayTeamScore} ${nm(m.Away)}${pens} [${m.StageName?.[0]?.Description ?? ""}]`;
      });
      return rows.length ? "FIFA official recent results — " + rows.join("; ") : null;
    },
  },
  {
    // tsdb:form -> recent W/L/D form from TheSportsDB's free 2026 WC standings table (no key).
    match: /^tsdb:form$/,
    fetch: async () => {
      const r = await fetch("https://www.thesportsdb.com/api/v1/json/3/lookuptable.php?l=4429&s=2026", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { table?: { strTeam?: string; strForm?: string; intPoints?: string }[] };
      const rows = (j.table ?? []).filter((t) => t.strForm).map((t) => `${t.strTeam} ${t.strForm} (${t.intPoints ?? "?"}pts)`);
      return rows.length ? "Recent form W=win/D=draw/L=loss (TheSportsDB) — " + rows.join("; ") : null;
    },
  },
  {
    // gnews:<query> -> latest Google News headlines (RSS, no key). Narrative signal:
    // lineups, injuries, momentum the structured feeds miss.
    match: /^gnews:(.+)$/,
    fetch: async (q) => {
      const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}%20when:7d&hl=en-US&gl=US&ceid=US:en`, { signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0" } });
      if (!r.ok) return null;
      const xml = await r.text();
      const titles = [...xml.matchAll(/<title>(.*?)<\/title>/g)]
        .map((m) => m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"'))
        .slice(1); // first <title> is the feed name
      const top = titles.slice(0, 6);
      return top.length ? `Recent news headlines (${q}) — ` + top.join(" | ") : null;
    },
  },
  {
    // record:all -> every team's group-stage record (W-D-L + points) = tournament form.
    match: /^record:all$/,
    fetch: async () => {
      const rows = await wcStandings();
      return rows.length ? "Group-stage records (Wins-Draws-Losses, points) — " + rows.map((r) => `${r.name} ${r.st.overall ?? "?"} (${r.st.points ?? "0"}pts)`).join("; ") : null;
    },
  },
  {
    // goaldiff:all -> every team's group-stage goal difference = dominance margin.
    match: /^goaldiff:all$/,
    fetch: async () => {
      const rows = await wcStandings();
      return rows.length ? "Group-stage goal difference — " + rows.map((r) => `${r.name} ${r.st.pointDifferential ?? "0"}`).join("; ") : null;
    },
  },
  {
    // goals:all -> every team's goals scored vs conceded = attack vs defense profile.
    match: /^goals:all$/,
    fetch: async () => {
      const rows = await wcStandings();
      return rows.length ? "Group-stage goals (scored-conceded) — " + rows.map((r) => `${r.name} ${r.st.pointsFor ?? "0"} scored, ${r.st.pointsAgainst ?? "0"} conceded`).join("; ") : null;
    },
  },
];

/**
 * Fetch a single source string's live context (or null). Exposed so callers
 * can fetch a specific source (e.g. a per-agent chosen source) without going
 * through a task's declared question sources.
 */
export async function fetchSource(src: string): Promise<string | null> {
  for (const h of SOURCE_HANDLERS) {
    const m = src.match(h.match);
    if (!m) continue;
    try { return await h.fetch(m[1]); } catch { return null; }
  }
  return null;
}

/**
 * Fetch live context for a task's questions from their declared resolution
 * sources, if a handler exists. A question may declare several sources as a
 * comma-separated list (e.g. "wc:A,odds:all") to pull more than one signal.
 * Distinct sources are fetched once each (deduped — a shared source like
 * odds:all is not re-fetched per question). Returns a context string (or
 * undefined). Never throws — a failed fetch just yields no context.
 */
export async function fetchContext(task: Task): Promise<string | undefined> {
  const questions = task.payload?.questions ?? [];
  const sources = new Set<string>();
  for (const q of questions) {
    for (const s of (q.resolution?.source ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      sources.add(s);
    }
  }
  const lines: string[] = [];
  for (const src of sources) {
    const v = await fetchSource(src);
    if (v) lines.push(`[${src}] ${v}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}
