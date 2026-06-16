// Scoring math, frozen per BLUEPRINT §4.7 / PROTOCOL.md. Golden vectors in
// test/ lock these bit-for-bit; any change requires a version bump.

import type { Answer, Question } from "./types.ts";

export const SCORING_VERSION = "0";

export const SKILL_SEED = 0.5;
export const SKILL_ALPHA = 0.1;
export const CONSENSUS_BASELINE_WEIGHT = 0.05;
export const MIN_SCORED_FOR_WEIGHT = 10;
export const MIN_SCORED_FOR_LEADERBOARD = 10;
export const STREAK_BONUS_PER_DAY = 0.05;
export const STREAK_BONUS_CAP = 0.5;

/** Binary Brier: (p - o)^2, o in {0,1}. Range [0,1], 0 is best. */
export function brierBinary(p: number, outcome: 0 | 1): number {
  if (p < 0 || p > 1) throw new Error(`probability out of range: ${p}`);
  return (p - outcome) ** 2;
}

/** Choice answer as one-hot multiclass Brier / 2 → 0 if correct, 1 if wrong. */
export function brierChoice(choice: string, correct: string): number {
  return choice === correct ? 0 : 1;
}

/** Workunit accuracy: 1 - mean Brier over answered questions. */
export function workunitAccuracy(briers: number[]): number {
  if (briers.length === 0) throw new Error("no briers");
  return 1 - briers.reduce((a, b) => a + b, 0) / briers.length;
}

/** EWMA skill update; only called on workunits the agent submitted. */
export function updateSkill(prevSkill: number, accuracy: number, alpha: number = SKILL_ALPHA): number {
  return alpha * accuracy + (1 - alpha) * prevSkill;
}

/** Points = round(base × accMult × repMult × streakMult). */
export function pointsFor(base: number, accuracy: number, tierIndex: number, streak: number): number {
  const accMult = 0.5 + 1.5 * accuracy;
  const repMult = 1 + (0.5 * tierIndex) / 3;
  const streakMult = 1 + Math.min(STREAK_BONUS_PER_DAY * Math.max(streak - 1, 0), STREAK_BONUS_CAP);
  return Math.round(base * accMult * repMult * streakMult);
}

/** Consensus weight; sybil-damped to baseline until enough scored history. */
export function consensusWeight(skill: number, scoredCount: number): number {
  if (scoredCount < MIN_SCORED_FOR_WEIGHT) return CONSENSUS_BASELINE_WEIGHT;
  return CONSENSUS_BASELINE_WEIGHT + Math.max(0, skill - 0.5);
}

export const TIER_NAMES = ["Worker", "Forager", "Scout", "Oracle"] as const;

/**
 * Tier from percentile of global trust among eligible agents (≥10 scored).
 * Oracle additionally requires ≥30 scored workunits.
 */
export function tierIndexFor(percentile: number, scoredCount: number): 0 | 1 | 2 | 3 {
  if (scoredCount < MIN_SCORED_FOR_LEADERBOARD) return 0;
  if (percentile >= 0.95 && scoredCount >= 30) return 3;
  if (percentile >= 0.8) return 2;
  if (percentile >= 0.5) return 1;
  return 0;
}

// --- Diversity dividend (the silicon-crowd mechanism) -----------------------
// The network pays for *uncorrelated* correctness. Near-duplicate answer
// vectors — copycats, herders, sybil rings — are clustered and each member's
// weight/points are divided by the cluster size, so k identical submissions
// count as ~one independent voice. This is stake-free sybil resistance and the
// mechanistic opposite of agreement-rewarding consensus.

/** Near-duplicate threshold: mean per-question distance at or below this is "the same voice". */
export const DIVERSITY_EPSILON = 0.05;

export interface AgentSubmission {
  agent_id: string;
  answers: Answer[];
}

/**
 * Mean per-question distance between two answer sets over `questions`.
 * Binary: |p_a − p_b|. Choice: 0 if same choice else 1. A missing answer on
 * either side counts as maximally distant (1). Range [0,1]; 0 = identical.
 */
export function answerDistance(a: Answer[], b: Answer[], questions: Question[]): number {
  if (questions.length === 0) throw new Error("no questions");
  const byA = new Map(a.map((x) => [x.q_id, x]));
  const byB = new Map(b.map((x) => [x.q_id, x]));
  let sum = 0;
  for (const q of questions) {
    const xa = byA.get(q.q_id);
    const xb = byB.get(q.q_id);
    if (!xa || !xb) { sum += 1; continue; }
    if (q.type === "binary") sum += Math.abs((xa.p ?? 0) - (xb.p ?? 0));
    else sum += xa.choice === xb.choice ? 0 : 1;
  }
  return sum / questions.length;
}

/**
 * Cluster near-duplicate submissions (distance ≤ epsilon, transitive via
 * union-find) and return each agent's diversity multiplier = 1 / clusterSize.
 * A lone, uncorrelated submission keeps multiplier 1; a ring of k identical
 * submissions gets 1/k each, so the ring contributes ~one voice.
 */
export function diversityMultipliers(
  submissions: AgentSubmission[],
  questions: Question[],
  epsilon: number = DIVERSITY_EPSILON,
): Map<string, number> {
  const n = submissions.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number): void => { parent[find(i)] = find(j); };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (answerDistance(submissions[i].answers, submissions[j].answers, questions) <= epsilon) union(i, j);
    }
  }
  const clusterSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    clusterSize.set(root, (clusterSize.get(root) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) out.set(submissions[i].agent_id, 1 / clusterSize.get(find(i))!);
  return out;
}

// --- Deliberation round helpers -----------------------------------------------
// Pure functions consumed by both the server (round advancement) and tests.

export type RoundAggregate = Record<
  string,
  { yes: number | null } | { top: [string, number][] }
>;

/**
 * Diversity-weighted interim aggregate of one deliberation round.
 * Binary: weighted mean p(yes). Choice: weighted vote share (top 5).
 */
export function interimRoundAggregate(
  submissions: AgentSubmission[],
  questions: Question[],
): RoundAggregate {
  if (submissions.length === 0) return {};
  const div = diversityMultipliers(submissions, questions);
  const out: RoundAggregate = {};
  for (const q of questions) {
    if (q.type === "binary") {
      let num = 0, den = 0;
      for (const s of submissions) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || a.p == null) continue;
        const w = div.get(s.agent_id) ?? 1;
        num += w * a.p;
        den += w;
      }
      out[q.q_id] = { yes: den > 0 ? num / den : null };
    } else {
      const votes: Record<string, number> = {};
      for (const s of submissions) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || !a.choice) continue;
        const w = div.get(s.agent_id) ?? 1;
        votes[a.choice] = (votes[a.choice] ?? 0) + w;
      }
      const tot = Object.values(votes).reduce((x, y) => x + y, 0) || 1;
      out[q.q_id] = {
        top: Object.entries(votes)
          .sort((x, y) => y[1] - x[1])
          .slice(0, 5)
          .map(([c, w]) => [c, w / tot] as [string, number]),
      };
    }
  }
  return out;
}

export interface RoundConsensusEntry {
  decision: number | string | null;
  confidence: number;
  committed: boolean;
  p?: number | null;
  votes?: Record<string, number>;
}

/**
 * Cross-inhibition consensus from the final deliberation round answers.
 * Identical math to the score pipeline in admin.ts but operating on raw
 * submissions rather than stored results — used by the server to compute
 * and store consensus_json when the last round closes.
 */
export function finalRoundConsensus(
  submissions: AgentSubmission[],
  questions: Question[],
): Record<string, RoundConsensusEntry> {
  if (submissions.length === 0) return {};
  const div = diversityMultipliers(submissions, questions);
  const out: Record<string, RoundConsensusEntry> = {};
  for (const q of questions) {
    if (q.type === "binary") {
      let yes = 0, no = 0;
      for (const s of submissions) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || a.p == null) continue;
        const w = div.get(s.agent_id) ?? 1;
        yes += w * a.p;
        no += w * (1 - a.p);
      }
      const c = crossInhibitionConsensus([{ id: "yes", support: yes }, { id: "no", support: no }]);
      const tot = yes + no || 1;
      out[q.q_id] = {
        decision: c.committed ? (c.choice === "yes" ? 1 : 0) : (yes >= no ? 1 : 0),
        confidence: Number(c.confidence.toFixed(4)),
        committed: c.committed,
        p: yes / tot,
      };
    } else {
      const votes: Record<string, number> = {};
      for (const s of submissions) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || !a.choice) continue;
        const w = div.get(s.agent_id) ?? 1;
        votes[a.choice] = (votes[a.choice] ?? 0) + w;
      }
      const entries = Object.entries(votes).sort((x, y) => y[1] - x[1]);
      const c = crossInhibitionConsensus(entries.map(([id, support]) => ({ id, support })));
      out[q.q_id] = {
        decision: c.committed ? c.choice : (entries[0]?.[0] ?? null),
        confidence: Number(c.confidence.toFixed(4)),
        committed: c.committed,
        votes,
      };
    }
  }
  return out;
}

// --- Cross-inhibition consensus (the swarm's decision engine) ----------------
// The honeybee/neural value-sensitive collective-decision mechanism: each
// candidate option recruits support in proportion to its value, sends a
// cross-inhibitory "stop-signal" to competing options, and the swarm commits
// when a leading option crosses a quorum. This breaks deadlock between
// near-equal options, amplifies a genuine lead into a confident call, and
// resists coordinated blocs (whose support is already discounted by
// diversityMultipliers upstream). Refs: Seeley et al., Science 2011; Pais et
// al., "A Mechanism for Value-Sensitive Decision-Making", PLOS One 2013.
//
// The dynamics are integrated deterministically with a hard iteration bound, so
// every published consensus number is reproducible from logs (RoE §7) and no
// input can cause an unbounded loop.

export const CONSENSUS_QUORUM = 0.6;       // committed fraction needed to commit
export const CONSENSUS_INHIBITION = 1.2;   // sigma — cross-inhibition strength
export const CONSENSUS_ABANDON = 0.1;      // spontaneous abandonment constant
export const CONSENSUS_DT = 0.05;          // integration step
export const CONSENSUS_MAX_ITERS = 400;    // hard upper bound on iterations

export interface ConsensusOption {
  id: string;
  support: number; // reputation/diversity-weighted support for this option (>= 0)
}

export interface ConsensusResult {
  choice: string | null;                 // leading option id (null only if no options)
  confidence: number;                    // committed fraction of the leading option, [0,1]
  committed: boolean;                    // confidence >= quorum (a confident swarm call)
  distribution: Record<string, number>; // committed fraction per option
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function crossInhibitionConsensus(
  options: ConsensusOption[],
  params: { quorum?: number; sigma?: number; abandon?: number; dt?: number; maxIters?: number } = {},
): ConsensusResult {
  const quorum = clamp01(params.quorum ?? CONSENSUS_QUORUM);
  const sigma = Math.max(0, Number.isFinite(params.sigma!) ? (params.sigma as number) : CONSENSUS_INHIBITION);
  const abandon = Math.max(0, Number.isFinite(params.abandon!) ? (params.abandon as number) : CONSENSUS_ABANDON);
  const dt = params.dt && params.dt > 0 ? params.dt : CONSENSUS_DT;
  const maxIters = Math.min(CONSENSUS_MAX_ITERS, Math.max(1, Math.floor(params.maxIters ?? CONSENSUS_MAX_ITERS)));

  const ids = options.map((o) => o.id);
  if (ids.length === 0) return { choice: null, confidence: 0, committed: false, distribution: {} };

  // defensive: non-finite or negative support counts as zero
  const raw = options.map((o) => (Number.isFinite(o.support) && o.support > 0 ? o.support : 0));
  const maxV = Math.max(...raw);
  const dist0 = Object.fromEntries(ids.map((id) => [id, 0]));
  if (maxV <= 0) return { choice: ids[0], confidence: 0, committed: false, distribution: dist0 };

  const v = raw.map((x) => x / maxV); // values normalized to [0,1]
  const y = new Array<number>(ids.length).fill(0); // committed fraction per option

  for (let iter = 0; iter < maxIters; iter++) {
    const S = y.reduce((a, b) => a + b, 0);
    const u = Math.max(0, 1 - S); // uncommitted pool
    const next = new Array<number>(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const vi = v[i];
      const recruit = vi * u * (1 + y[i]);                 // discovery + recruitment ∝ value
      const abandonI = vi > 0 ? (abandon * y[i]) / vi : abandon * y[i]; // abandonment ∝ 1/value
      const inhibit = sigma * y[i] * (S - y[i]);           // stop-signals from competitors
      next[i] = Math.max(0, y[i] + dt * (recruit - abandonI - inhibit));
    }
    let total = 0;
    for (let i = 0; i < ids.length; i++) total += next[i];
    for (let i = 0; i < ids.length; i++) y[i] = total > 1 ? next[i] / total : next[i]; // keep committed <= 1
    let maxY = 0;
    for (let i = 0; i < ids.length; i++) if (y[i] > maxY) maxY = y[i];
    if (maxY >= quorum) break;
  }

  let best = 0;
  for (let i = 1; i < ids.length; i++) if (y[i] > y[best]) best = i;
  const confidence = clamp01(y[best]);
  return {
    choice: ids[best],
    confidence,
    committed: confidence >= quorum,
    distribution: Object.fromEntries(ids.map((id, i) => [id, clamp01(y[i])])),
  };
}
