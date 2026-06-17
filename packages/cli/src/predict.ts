// Build the prediction prompt (fixed frame + owner's SWARMING.md + questions)
// and parse the model's JSON answers. Mission-generic: works on any
// question-slate payload.

import { RATIONALE_MAX_CHARS, type Answer, type Question, type Task } from "../../protocol/src/index.ts";
import type { ModelBackend } from "./model.ts";

// Multi-round deliberation context the server attaches to a task in round 2+.
interface RoundInfo {
  current_round: number;
  total_rounds: number;
  round_leaning?: unknown;
}

export function buildPrompt(task: Task, agentName: string, swarmingMd: string): string {
  const questions = task.payload.questions.map((q) => ({
    q_id: q.q_id,
    type: q.type,
    text: q.text,
    ...(q.type === "choice" ? { choices: q.choices } : {}),
  }));
  const lines = [
    `You are ${agentName}, an independent agent in the Swarming network, answering a scored question slate.`,
    `Answer each question with a calibrated probability (binary: "p" in [0,1]) or a single`,
    `"choice" (choice questions), plus a one-line "rationale" (max ${RATIONALE_MAX_CHARS} characters).`,
    `You are Brier-scored on accuracy; overconfidence is penalized.`,
    ``,
    `--- OWNER STRATEGY (overrides defaults where they conflict) ---`,
    swarmingMd.trim(),
    `--- END OWNER STRATEGY ---`,
    ``,
  ];

  // data.read: live context the worker fetched from declared sources (model-agnostic).
  const context = (task as Task & { context?: string }).context;
  if (context) {
    lines.push(`--- LIVE CONTEXT (fetched by your data.read tool — weigh it) ---`, context, `--- END CONTEXT ---`, ``);
  }

  // Deliberation: in round 2+, show the swarm's current leaning and ask the
  // agent to reconsider. Independence still matters — don't just follow.
  const round = (task as Task & { round?: RoundInfo }).round;
  if (round && round.current_round > 1 && round.round_leaning != null) {
    lines.push(
      `This is round ${round.current_round} of ${round.total_rounds} of swarm deliberation.`,
      `The swarm's current leaning (aggregate of all agents): ${JSON.stringify(round.round_leaning)}.`,
      `Reconsider your answer. Keep it if you still believe it; move toward the swarm only if its`,
      `view genuinely changes your mind. Do not blindly follow the crowd — independent signal is rewarded.`,
      ``,
    );
  }

  lines.push(
    `Questions (JSON):`,
    JSON.stringify(questions, null, 2),
    ``,
    `Respond with ONLY a JSON array, one object per question:`,
    `[{"q_id": "...", "p": 0.62, "rationale": "..."}, {"q_id": "...", "choice": "...", "rationale": "..."}]`,
  );
  return lines.join("\n");
}

export function parseAnswers(raw: string, questions: Question[]): Answer[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("model did not return a JSON array");
  const parsed = JSON.parse(match[0]) as Answer[];
  const byId = new Map(parsed.map((a) => [a.q_id, a]));
  return questions.map((q) => {
    const a = byId.get(q.q_id);
    if (!a) throw new Error(`model skipped ${q.q_id}`);
    const rationale = String(a.rationale ?? "").slice(0, RATIONALE_MAX_CHARS);
    if (q.type === "binary") {
      const p = Math.min(1, Math.max(0, Number(a.p)));
      if (Number.isNaN(p)) throw new Error(`model gave no probability for ${q.q_id}`);
      return { q_id: q.q_id, p, rationale };
    }
    const raw2 = String(a.choice ?? "").trim();
    // small local models drift on casing/diacritics — match leniently, submit canonically
    const choice = q.choices.find((c) => c.localeCompare(raw2, undefined, { sensitivity: "base" }) === 0)
      ?? q.choices.find((c) => c.toLowerCase().includes(raw2.toLowerCase()) && raw2.length >= 3);
    if (!choice) throw new Error(`model chose '${raw2}' for ${q.q_id}, not in options`);
    return { q_id: q.q_id, choice, rationale };
  });
}

export async function answerTask(
  task: Task,
  agentName: string,
  swarmingMd: string,
  backend: ModelBackend,
): Promise<Answer[]> {
  const prompt = buildPrompt(task, agentName, swarmingMd);
  try {
    return parseAnswers(await backend.complete(prompt), task.payload.questions);
  } catch (e) {
    // one retry with the error fed back — smaller models often self-correct
    const retry = prompt + `\n\nYour previous answer was invalid (${e instanceof Error ? e.message : e}). ` +
      `Answer again. JSON array only; "choice" must EXACTLY match one of the listed choices.`;
    return parseAnswers(await backend.complete(retry), task.payload.questions);
  }
}
