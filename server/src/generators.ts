// Typed generator library. A generator turns operator/mission input into a
// workunit payload. Declarative vocabulary only — mission packages select a
// generator by name; they never ship code.

import type { Question, QuestionSlatePayload, TaskPayload } from "../../packages/protocol/src/index.ts";

type GeneratorFn = (input: unknown) => TaskPayload;

function questionSlate(input: unknown): QuestionSlatePayload {
  const { questions } = input as { questions: Question[] };
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("question-slate: input must have a non-empty questions[]");
  }
  for (const q of questions) {
    if (!q.q_id || !q.text) throw new Error("question-slate: every question needs q_id and text");
    if (q.type === "choice" && (!Array.isArray(q.choices) || q.choices.length < 2)) {
      throw new Error(`question-slate: ${q.q_id} choice question needs >=2 choices`);
    }
    if (q.type !== "binary" && q.type !== "choice") {
      throw new Error(`question-slate: ${q.q_id} unknown type`);
    }
    if (!q.resolution?.source || !q.resolution?.rule) {
      throw new Error(`question-slate: ${q.q_id} must declare resolution source+rule (verifiability rule)`);
    }
  }
  return { type: "question-slate", questions };
}

export const GENERATORS: Record<string, GeneratorFn> = {
  "question-slate": questionSlate,
};
