import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  generateKeypair,
  publicKeyRawFromSeed,
  signPayload,
  verifyPayload,
  agentIdFromPubkey,
  hashCanonical,
  nameFromPubkey,
  brierBinary,
  brierChoice,
  workunitAccuracy,
  updateSkill,
  pointsFor,
  consensusWeight,
  tierIndexFor,
  answerDistance,
  diversityMultipliers,
  crossInhibitionConsensus,
  interimRoundAggregate,
  finalRoundConsensus,
  type Answer,
  type Question,
} from "../src/index.ts";

test("jcs: sorts keys recursively, no whitespace", () => {
  assert.equal(canonicalize({ b: 1, a: { d: null, c: [true, "x"] } }), '{"a":{"c":[true,"x"],"d":null},"b":1}');
});

test("jcs: rejects undefined and NaN", () => {
  assert.throws(() => canonicalize(undefined));
  assert.throws(() => canonicalize(NaN));
});

test("crypto: sign/verify round-trip, tamper detection", () => {
  const { publicKeyRaw, privateSeed } = generateKeypair();
  assert.equal(publicKeyRaw.length, 32);
  assert.equal(privateSeed.length, 32);
  assert.deepEqual(publicKeyRawFromSeed(privateSeed), publicKeyRaw);

  const payload = { agent_id: agentIdFromPubkey(publicKeyRaw), task_id: "t_x", ts: 1760000000 };
  const sig = signPayload(payload, privateSeed);
  assert.ok(verifyPayload(payload, sig, publicKeyRaw));
  assert.ok(!verifyPayload({ ...payload, ts: 1760000001 }, sig, publicKeyRaw));
  assert.ok(!verifyPayload(payload, sig, generateKeypair().publicKeyRaw));
});

test("crypto: signature independent of key order (canonical form)", () => {
  const { publicKeyRaw, privateSeed } = generateKeypair();
  const a = { x: 1, y: 2 };
  const b = { y: 2, x: 1 };
  assert.equal(signPayload(a, privateSeed), signPayload(b, privateSeed));
  assert.equal(hashCanonical(a), hashCanonical(b));
  void publicKeyRaw;
});

test("names: deterministic and well-formed", () => {
  const { publicKeyRaw } = generateKeypair();
  const n1 = nameFromPubkey(publicKeyRaw);
  assert.equal(n1, nameFromPubkey(publicKeyRaw));
  assert.match(n1, /^[a-z]+-[a-z]+-\d{2}$/);
});

test("scoring: golden values", () => {
  assert.equal(brierBinary(0.62, 1), 0.1444 + brierBinary(0.62, 1) - 0.1444); // exact float below
  assert.ok(Math.abs(brierBinary(0.62, 1) - 0.1444) < 1e-12);
  assert.ok(Math.abs(brierBinary(0.62, 0) - 0.3844) < 1e-12);
  assert.equal(brierChoice("SOL", "SOL"), 0);
  assert.equal(brierChoice("ETH", "SOL"), 1);

  const acc = workunitAccuracy([0.1444, 1]);
  assert.ok(Math.abs(acc - 0.4278) < 1e-12);

  const skill = updateSkill(0.5, acc);
  assert.ok(Math.abs(skill - 0.49278) < 1e-12);

  // base 10, acc 0.4278 → accMult 1.1417, tier 0, streak 1 → round(11.417) = 11
  assert.equal(pointsFor(10, acc, 0, 1), 11);
  // streak cap: streak 20 → bonus capped at 1.5
  assert.equal(pointsFor(10, 1, 3, 20), Math.round(10 * 2 * 1.5 * 1.5));

  assert.equal(consensusWeight(0.9, 5), 0.05); // damped: not enough history
  assert.ok(Math.abs(consensusWeight(0.7, 12) - 0.25) < 1e-12);
  assert.equal(consensusWeight(0.3, 12), 0.05); // below-seed skill floors at baseline

  assert.equal(tierIndexFor(0.99, 5), 0); // ineligible regardless of percentile
  assert.equal(tierIndexFor(0.99, 31), 3);
  assert.equal(tierIndexFor(0.99, 12), 2); // Oracle needs 30+
  assert.equal(tierIndexFor(0.6, 12), 1);
  assert.equal(tierIndexFor(0.1, 12), 0);
});

test("scoring: brier rejects out-of-range probability", () => {
  assert.throws(() => brierBinary(1.2, 1));
  assert.throws(() => brierBinary(-0.1, 0));
});

test("diversity: answer distance (binary + choice)", () => {
  const qs: Question[] = [
    { q_id: "a", type: "binary", text: "", resolution: { source: "x", rule: "y", resolve_at: "z" } },
    { q_id: "b", type: "choice", text: "", choices: ["X", "Y"], resolution: { source: "x", rule: "y", resolve_at: "z" } },
  ];
  const mk = (p: number, c: string): Answer[] => [
    { q_id: "a", p, rationale: "" },
    { q_id: "b", choice: c, rationale: "" },
  ];
  assert.equal(answerDistance(mk(0.8, "X"), mk(0.8, "X"), qs), 0); // identical
  // |0.8-0.6|=0.2 on a, choice differs=1 on b → mean 0.6
  assert.ok(Math.abs(answerDistance(mk(0.8, "X"), mk(0.6, "Y"), qs) - 0.6) < 1e-12);
  // missing answer = maximally distant
  assert.equal(answerDistance([{ q_id: "a", p: 0.8, rationale: "" }], mk(0.8, "X"), qs), 0.5);
});

test("diversity: clusters split weight, lone voices keep it", () => {
  // 3 questions — the minimum slate where clustering is meaningful
  const qs: Question[] = ["a", "b", "c"].map((id) => (
    { q_id: id, type: "binary", text: "", resolution: { source: "x", rule: "y", resolve_at: "z" } } as Question
  ));
  const sub = (id: string, p: number) => ({ agent_id: id, answers: qs.map((q) => ({ q_id: q.q_id, p, rationale: "" })) });
  // three identical sybils + one distinct voice
  const m = diversityMultipliers(
    [sub("s1", 0.9), sub("s2", 0.9), sub("s3", 0.9), sub("lone", 0.1)],
    qs,
  );
  assert.ok(Math.abs(m.get("s1")! - 1 / 3) < 1e-12);
  assert.ok(Math.abs(m.get("s2")! - 1 / 3) < 1e-12);
  assert.ok(Math.abs(m.get("s3")! - 1 / 3) < 1e-12);
  assert.equal(m.get("lone"), 1);

  // within-epsilon herders merge; clearly-different stay separate
  const m2 = diversityMultipliers([sub("h1", 0.90), sub("h2", 0.93), sub("indep", 0.40)], qs);
  assert.ok(Math.abs(m2.get("h1")! - 0.5) < 1e-12); // 0.03 <= epsilon → paired
  assert.ok(Math.abs(m2.get("h2")! - 0.5) < 1e-12);
  assert.equal(m2.get("indep"), 1);
});

test("diversity: no clustering below MIN_QUESTIONS_FOR_DIVERSITY", () => {
  // On a 1-question slate, picking the same option is not collusion evidence —
  // discounting it would make any 3-1 majority cancel to a dead tie.
  const qs: Question[] = [
    { q_id: "m", type: "choice", text: "", choices: ["X", "Y"], resolution: { source: "x", rule: "y", resolve_at: "z" } },
  ];
  const sub = (id: string, c: string) => ({ agent_id: id, answers: [{ q_id: "m", choice: c, rationale: "" }] });
  const m = diversityMultipliers([sub("a1", "X"), sub("a2", "X"), sub("a3", "X"), sub("a4", "Y")], qs);
  for (const id of ["a1", "a2", "a3", "a4"]) assert.equal(m.get(id), 1);
});

test("consensus: commits to a clear winner with high confidence", () => {
  const r = crossInhibitionConsensus([{ id: "A", support: 10 }, { id: "B", support: 2 }]);
  assert.equal(r.choice, "A");
  assert.ok(r.committed);
  assert.ok(r.confidence > 0.6); // well past the quorum threshold
});

test("consensus: picks the stronger side and sharpens a near-tie", () => {
  const r = crossInhibitionConsensus([{ id: "A", support: 11 }, { id: "B", support: 9 }]);
  assert.equal(r.choice, "A");
  assert.ok(r.distribution.A > r.distribution.B);
  // cross-inhibition amplifies the lead beyond the raw 11/20 = 0.55 input share
  const shareA = r.distribution.A / (r.distribution.A + r.distribution.B);
  assert.ok(shareA > 0.55);
});

test("consensus: abstains (no commit) on a perfect deadlock", () => {
  const r = crossInhibitionConsensus([{ id: "A", support: 5 }, { id: "B", support: 5 }]);
  assert.ok(!r.committed);
});

test("consensus: defensive on empty and zero/NaN support", () => {
  assert.equal(crossInhibitionConsensus([]).choice, null);
  const z = crossInhibitionConsensus([{ id: "A", support: 0 }, { id: "B", support: NaN }]);
  assert.ok(!z.committed);
  assert.equal(z.confidence, 0);
});

// --- Deliberation round helpers -----------------------------------------------

const deliberationQs: Question[] = [
  { q_id: "bin1", type: "binary", text: "?", resolution: { source: "x", rule: "y", resolve_at: "z" } },
  { q_id: "ch1", type: "choice", text: "?", choices: ["A", "B", "C"], resolution: { source: "x", rule: "y", resolve_at: "z" } },
];

test("interimRoundAggregate: binary mean + choice vote share", () => {
  const subs = [
    { agent_id: "a1", answers: [{ q_id: "bin1", p: 0.8, rationale: "" }, { q_id: "ch1", choice: "A", rationale: "" }] },
    { agent_id: "a2", answers: [{ q_id: "bin1", p: 0.6, rationale: "" }, { q_id: "ch1", choice: "B", rationale: "" }] },
  ];
  const agg = interimRoundAggregate(subs, deliberationQs);
  // equal diversity weights → simple mean for binary
  const bin = agg["bin1"] as { yes: number | null };
  assert.ok(Math.abs(bin.yes! - 0.7) < 1e-10);
  // each choice gets 50%
  const ch = agg["ch1"] as { top: [string, number][] };
  assert.equal(ch.top.length, 2);
  assert.ok(ch.top.every(([, share]) => Math.abs(share - 0.5) < 1e-10));
});

test("interimRoundAggregate: empty submissions returns empty object", () => {
  assert.deepEqual(interimRoundAggregate([], deliberationQs), {});
});

test("interimRoundAggregate: diversity-discounts duplicate answers", () => {
  // two identical agents cluster → each gets weight 0.5; distinct agent keeps 1
  const subs = [
    { agent_id: "s1", answers: [{ q_id: "bin1", p: 0.9, rationale: "" }, { q_id: "ch1", choice: "A", rationale: "" }] },
    { agent_id: "s2", answers: [{ q_id: "bin1", p: 0.9, rationale: "" }, { q_id: "ch1", choice: "A", rationale: "" }] },
    { agent_id: "lone", answers: [{ q_id: "bin1", p: 0.1, rationale: "" }, { q_id: "ch1", choice: "B", rationale: "" }] },
  ];
  const agg = interimRoundAggregate(subs, deliberationQs);
  // sybils contribute total weight 0.5+0.5=1, lone contributes 1 → mean = (1*0.9 + 1*0.1)/2 = 0.5
  const bin = agg["bin1"] as { yes: number | null };
  assert.ok(Math.abs(bin.yes! - 0.5) < 1e-10);
});

test("finalRoundConsensus: committed call on clear binary winner", () => {
  const subs = [
    { agent_id: "a1", answers: [{ q_id: "bin1", p: 0.95, rationale: "" }, { q_id: "ch1", choice: "A", rationale: "" }] },
    { agent_id: "a2", answers: [{ q_id: "bin1", p: 0.90, rationale: "" }, { q_id: "ch1", choice: "A", rationale: "" }] },
    { agent_id: "a3", answers: [{ q_id: "bin1", p: 0.85, rationale: "" }, { q_id: "ch1", choice: "A", rationale: "" }] },
  ];
  const con = finalRoundConsensus(subs, deliberationQs);
  assert.equal(con["bin1"].decision, 1);  // strong yes
  assert.ok(con["bin1"].committed);
  assert.equal(con["ch1"].decision, "A");
  assert.ok(con["ch1"].committed);
});

test("finalRoundConsensus: plurality fallback on deadlock", () => {
  const subs = [
    { agent_id: "a1", answers: [{ q_id: "bin1", p: 0.5, rationale: "" }, { q_id: "ch1", choice: "A", rationale: "" }] },
    { agent_id: "a2", answers: [{ q_id: "bin1", p: 0.5, rationale: "" }, { q_id: "ch1", choice: "B", rationale: "" }] },
  ];
  const con = finalRoundConsensus(subs, deliberationQs);
  // binary deadlock: p(yes)=p(no)=0.5 → not committed, decision by plurality (yes >= no → 1)
  assert.ok(!con["bin1"].committed);
  assert.equal(con["bin1"].decision, 1); // 0.5 >= 0.5 → yes wins tie
});
