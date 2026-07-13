import { test } from "node:test";
import assert from "node:assert/strict";
import { deliberate, type AgentContext } from "../src/index.ts";

function fixed(p: number, rationale = "r"): (ctx: AgentContext) => Promise<{ answer: number; confidence: number; rationale: string }> {
  return async () => ({ answer: p, confidence: 0.8, rationale });
}

test("deliberate: unanimous binary agreement commits", async () => {
  const v = await deliberate({
    question: "will it rain?",
    agents: [fixed(0.9), fixed(0.92), fixed(0.88), fixed(0.91)],
    rounds: 1,
  });
  assert.equal(v.committed, true);
  assert.equal(v.answer, 1);
  assert.ok(v.confidence >= 0.6);
  assert.equal(v.rounds, 1);
  assert.equal(v.transcript.length, 4);
});

test("deliberate: perfect deadlock abstains (committed:false) but still returns a leaning answer", async () => {
  const v = await deliberate({
    question: "coin flip?",
    agents: [fixed(0.99), fixed(0.01)],
    rounds: 1,
  });
  assert.equal(v.committed, false);
  assert.ok(v.answer === 0 || v.answer === 1);
});

test("deliberate: choice-type consensus", async () => {
  const choice = (c: string) => async () => ({ answer: c, confidence: 0.7, rationale: "" });
  const v = await deliberate({
    question: "cat or dog?",
    agents: [choice("cat"), choice("cat"), choice("cat"), choice("dog")],
    rounds: 1,
  });
  assert.equal(v.answer, "cat");
});

test("deliberate: round>1 agents see the prior round's leaning; round 1 sees none", async () => {
  const seen: (AgentContext["leaning"] | undefined)[] = [];
  const agent = async (ctx: AgentContext) => {
    seen.push(ctx.leaning);
    return { answer: 0.7, confidence: 0.6, rationale: "" };
  };
  await deliberate({ question: "q", agents: [agent, agent], rounds: 3 });
  // 2 agents x 3 rounds = 6 calls; round 1's two calls have leaning undefined.
  assert.equal(seen.length, 6);
  assert.equal(seen[0], undefined);
  assert.equal(seen[1], undefined);
  assert.notEqual(seen[2], undefined);
});

test("deliberate: quorum option lowers the bar to commit", async () => {
  // 55% support commits nowhere near the default 0.6 quorum...
  const v = await deliberate({
    question: "q",
    agents: [fixed(0.6), fixed(0.6), fixed(0.4), fixed(0.4)],
    rounds: 1,
  });
  assert.equal(v.committed, false);
  // ...but does with an explicitly lowered quorum.
  const v2 = await deliberate({
    question: "q",
    agents: [fixed(0.6), fixed(0.6), fixed(0.4), fixed(0.4)],
    rounds: 1,
    quorum: 0.3,
  });
  assert.equal(v2.committed, true);
});

test("deliberate: single question never clusters agents (matches the network's own MIN_QUESTIONS_FOR_DIVERSITY guard)", async () => {
  const v = await deliberate({
    question: "q",
    agents: [fixed(0.9), fixed(0.9), fixed(0.9)], // three IDENTICAL answers
    rounds: 1,
  });
  assert.equal(v.clusters.length, 3);
  for (const c of v.clusters) assert.equal(c.multiplier, 1);
});

test("deliberate: throws on empty agents array", async () => {
  await assert.rejects(() => deliberate({ question: "q", agents: [] }));
});
