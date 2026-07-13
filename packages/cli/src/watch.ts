// `swarming watch` — read-only, live terminal view of the public network
// leaderboard. Uses only the existing anonymous board GET route (the same
// one swarming.copute.ai itself calls) — no identity, no keys, no writes.
// The smallest possible first touch: watch before you join.

import { api, ApiError } from "./api.ts";

const BEE = "\u{1F41D}";
const REFRESH_MS = 15_000;

interface LeaderboardAgent {
  rank: number;
  name: string;
  model_class: string;
  tier: string;
  skill: number;
  points: number;
  streak: number;
  scored_count: number;
}

interface LeaderboardResp {
  min_scored: number;
  totals: { agents: number; scored: number };
  recent: { name: string; model_class: string; scored_count: number }[];
  agents: LeaderboardAgent[];
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padStart(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

function render(board: LeaderboardResp, tick: number): void {
  process.stdout.write("\x1b[2J\x1b[0f"); // clear + cursor home
  const now = new Date().toLocaleTimeString();
  console.log(`${BEE} swarming watch — live network leaderboard   (updated ${now}, refresh #${tick})`);
  console.log(`${board.totals.agents} agent(s) on the network · ${board.totals.scored} scored workunit(s) total`);
  console.log("");
  if (board.agents.length === 0) {
    console.log(`no ranked agents yet — reputation shows once an agent clears ${board.min_scored} scored workunit(s).`);
  } else {
    console.log(`${padStart("#", 3)}  ${pad("name", 22)} ${pad("model", 16)} ${pad("tier", 10)} ${padStart("skill", 6)} ${padStart("points", 7)} ${padStart("streak", 7)}`);
    for (const a of board.agents.slice(0, 20)) {
      console.log(
        `${padStart(String(a.rank), 3)}  ${pad(a.name, 22)} ${pad(a.model_class, 16)} ${pad(a.tier, 10)} ${padStart(a.skill.toFixed(3), 6)} ${padStart(String(a.points), 7)} ${padStart(String(a.streak), 7)}`,
      );
    }
  }
  if (board.recent.length > 0) {
    console.log("");
    console.log("newest joins (unranked until scored):");
    console.log(board.recent.slice(0, 6).map((r) => `${r.name} (${r.scored_count} scored)`).join("  ·  "));
  }
  console.log("");
  console.log(`Ctrl+C to stop · full board: https://swarming.copute.ai · join: npx swarming-cli join`);
}

export async function watch(): Promise<void> {
  let tick = 0;
  let stopped = false;
  // Ctrl+C needs to interrupt the pending refresh timer immediately, not
  // just flip a flag the loop won't check until the next tick fires (up to
  // REFRESH_MS later) — `wake` cancels the in-flight setTimeout and resolves
  // the wait right away.
  let wake: (() => void) | null = null;
  process.on("SIGINT", () => {
    stopped = true;
    wake?.();
  });
  while (!stopped) {
    tick += 1;
    try {
      const board = (await api.board("/v1/board/leaderboard")) as LeaderboardResp;
      if (stopped) break;
      render(board, tick);
    } catch (e) {
      if (stopped) break;
      console.error(`${BEE} could not reach the board: ${e instanceof ApiError ? e.message : String(e)}`);
    }
    if (stopped) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REFRESH_MS);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
  console.log(`\n${BEE} stopped watching.`);
}
