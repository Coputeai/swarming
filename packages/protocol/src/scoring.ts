// Scoring math, frozen per BLUEPRINT §4.7 / PROTOCOL.md. Golden vectors in
// test/ lock these bit-for-bit; any change requires a version bump.

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
