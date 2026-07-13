// swarming-consensus — the network's cross-inhibition consensus engine as a
// standalone library. Same engine code as the network (imports directly from
// @swarming/protocol), not a fork: run your own N model calls through the
// swarm's diversity-weighted, quorum-committing deliberation without joining
// the network. See DEV_LAUNCH_BRIEF.md §6.6 (F-C) for the frozen API design.

// Imported directly from scoring.ts/types.ts (not the protocol package's
// barrel index) so this library pulls in only the consensus math — not the
// network's ed25519/identity code, which needs node:crypto and has nothing
// to do with deliberation.
import {
  answerDistance,
  crossInhibitionConsensus,
  diversityMultipliers,
  finalRoundConsensus,
  interimRoundAggregate,
  DIVERSITY_EPSILON,
  MIN_QUESTIONS_FOR_DIVERSITY,
  CONSENSUS_QUORUM,
} from "../../protocol/src/scoring.ts";
import type { Answer, Question } from "../../protocol/src/types.ts";

// The synthetic single-question id every deliberate() call uses internally
// when calling into the (multi-question-shaped) network scoring functions.
const Q_ID = "q";

export type Leaning = { yes: number | null } | { top: [string, number][] };

export interface AgentContext {
  question: string;
  round: number;
  leaning?: Leaning;
}

export interface AgentResponse {
  answer: string | number;
  confidence: number;
  rationale?: string;
}

export type DeliberatingAgent = (ctx: AgentContext) => Promise<AgentResponse>;

export interface ClusterInfo {
  /** Indices into the `agents` array that voiced as one near-duplicate cluster. */
  members: number[];
  /** 1 / members.length — the weight each member's vote was discounted to. */
  multiplier: number;
}

export interface Turn {
  round: number;
  /** Index into the `agents` array. */
  agent: number;
  answer: string | number;
  confidence: number;
  rationale?: string;
}

export interface Verdict {
  /** The swarm's call — the leading candidate even when `committed` is false. */
  answer: string | number | null;
  confidence: number;
  /** false = the swarm did not reach quorum; an honest abstention, not a tie-break. */
  committed: boolean;
  rounds: number;
  clusters: ClusterInfo[];
  transcript: Turn[];
}

export interface DeliberateOptions {
  question: string;
  agents: DeliberatingAgent[];
  /** Deliberation rounds; each round after the first sees the prior round's leaning. Default 3. */
  rounds?: number;
  /** Committed-fraction threshold to call quorum. Default is the engine default (0.6). */
  quorum?: number;
}

// Numeric answers are treated as probabilities (0..1), same convention the
// network uses for binary questions — "answer: number" IS "p". Anything else
// (including numeric strings) is a choice, compared by exact string match.
function toAnswer(r: AgentResponse): Answer {
  const base = { q_id: Q_ID, rationale: r.rationale ?? "" };
  return typeof r.answer === "number" ? { ...base, p: r.answer } : { ...base, choice: String(r.answer) };
}

// Duplicates the union-find pass diversityMultipliers runs internally, using
// the same distance function + epsilon, so deliberate() can also report WHICH
// agents clustered together — information the network's own API never needs
// to expose (it only stores final multipliers), but that a library caller
// watching the transcript will want.
function clusterAgents(submissions: { agent_id: string; answers: Answer[] }[], questions: Question[]): ClusterInfo[] {
  const n = submissions.length;
  if (n === 0) return [];
  if (questions.length < MIN_QUESTIONS_FOR_DIVERSITY) {
    return submissions.map((_, i) => ({ members: [i], multiplier: 1 }));
  }
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number): void => { parent[find(i)] = find(j); };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (answerDistance(submissions[i].answers, submissions[j].answers, questions) <= DIVERSITY_EPSILON) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return [...groups.values()].map((members) => ({ members, multiplier: 1 / members.length }));
}

/**
 * Run N independent agents through the swarm's structured deliberation:
 * blind answers, diversity-weighted interim leaning shared back, quorum
 * cross-inhibition consensus on the final round — or an honest abstention
 * if the swarm never converges. `agents` are plain async functions; nothing
 * here is coupled to any model provider or framework.
 *
 * NOTE (single-question diversity guard): the network only clusters
 * near-duplicate answers on slates of 2+ questions — on one question,
 * "picked the same side" isn't evidence of collusion (see
 * MIN_QUESTIONS_FOR_DIVERSITY in @swarming/protocol). Since deliberate()
 * always asks exactly one question, `clusters` will always come back as one
 * singleton cluster per agent (multiplier 1) — this is the same defensive
 * behavior the network itself has, not a limitation specific to the library.
 */
export async function deliberate(opts: DeliberateOptions): Promise<Verdict> {
  const { question, agents } = opts;
  const rounds = Math.max(1, Math.floor(opts.rounds ?? 3));
  if (agents.length === 0) throw new Error("deliberate: agents must be a non-empty array");

  const transcript: Turn[] = [];
  let leaning: Leaning | undefined;
  let lastSubmissions: { agent_id: string; answers: Answer[] }[] = [];
  const resolution = { source: "library", rule: "deliberate", resolve_at: "" };
  let question_: Question = { q_id: Q_ID, type: "binary", text: question, resolution };

  for (let round = 1; round <= rounds; round++) {
    const responses = await Promise.all(agents.map((agent) => agent({ question, round, leaning })));
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      transcript.push({ round, agent: i, answer: r.answer, confidence: r.confidence, rationale: r.rationale });
    }

    // Agents can disagree on answer shape (a number vs. a string) in the same
    // round — the frozen API's `answer: string | number` doesn't force a
    // fixed type. The MAJORITY shape decides the round's type; answers of
    // the minority shape are excluded from the tally (they'd have no honest
    // representation as the other type) but stay visible in `transcript` —
    // never silently misread as the round's winner the way an "every answer
    // must agree" check would (a lone dissenting string used to make an
    // entire numeric majority disappear from the vote).
    const numericCount = responses.filter((r) => typeof r.answer === "number").length;
    const isBinary = numericCount >= responses.length - numericCount;
    const submissions = responses
      .map((r, i) => ({ agent_id: String(i), answer: toAnswer(r) }))
      .filter((s) => (isBinary ? s.answer.p != null : s.answer.choice != null))
      .map((s) => ({ agent_id: s.agent_id, answers: [s.answer] }));

    lastSubmissions = submissions;
    question_ = isBinary
      ? { q_id: Q_ID, type: "binary", text: question, resolution }
      : { q_id: Q_ID, type: "choice", text: question, choices: [...new Set(submissions.map((s) => s.answers[0].choice!))], resolution };

    if (round < rounds) {
      const aggregate = interimRoundAggregate(submissions, [question_]);
      leaning = aggregate[Q_ID] as Leaning;
    }
  }

  const consensus = finalRoundConsensus(lastSubmissions, [question_], { quorum: opts.quorum })[Q_ID];
  const clusters = clusterAgents(lastSubmissions, [question_]);

  return {
    answer: consensus?.decision ?? null,
    confidence: consensus?.confidence ?? 0,
    committed: consensus?.committed ?? false,
    rounds,
    clusters,
    transcript,
  };
}

// Re-exported so callers can hand-tune quorum without hunting through
// @swarming/protocol, and for parity with the frozen API's `quorum?` option.
export { CONSENSUS_QUORUM, crossInhibitionConsensus, diversityMultipliers };
