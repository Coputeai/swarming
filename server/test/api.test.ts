// Public join/submit API tests: key issuance, auth binding, rotation,
// burst limits and daily quotas. Runs against an in-memory SQLite DB.
// db.ts/app.ts read env at module load, so they must be imported dynamically
// AFTER env is set (static imports are hoisted above these assignments).
process.env.SWARMING_DB = ":memory:";
process.env.SWARMING_LIMIT_RESULTS_PER_MIN = "5";
process.env.SWARMING_QUOTA_WORK_PER_DAY = "8";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  generateKeypair,
  hashCanonical,
  signPayload,
} from "../../packages/protocol/src/index.ts";

const { openDb } = await import("../src/db.ts");
const { buildApp } = await import("../src/app.ts");

const db = openDb();
const app = buildApp(db);

// Seed one default mission and one open workunit (bypasses missions/ dir).
const manifest = {
  id: "test-slate", version: "0.0.1", author: "test", title: "Test slate", default: true,
  pattern: "broadcast", verification: { mode: "oracle", resolver: "manual-dev" },
  generator: "question-slate", capabilities: ["llm.reasoning"], schedule: "0 0 * * *",
  window_hours: 24, points: { base: 10, daily_budget: 1000 },
};
db.prepare("INSERT INTO missions (mission_id, version, manifest_json, status) VALUES (?, ?, ?, 'active')")
  .run(manifest.id, manifest.version, JSON.stringify(manifest));
const future = new Date(Date.now() + 3600_000).toISOString();
db.prepare(
  `INSERT INTO workunits (workunit_id, mission_id, payload_json, published_at, closes_at, resolve_at, status)
   VALUES ('wu_t1', 'test-slate', ?, ?, ?, ?, 'open')`,
).run(
  JSON.stringify({ type: "question-slate", questions: [{ q_id: "q1", type: "binary", text: "up?", resolution: { source: "manual", rule: "manual", resolve_at: future } }] }),
  new Date().toISOString(), future, future,
);

function ts(): number { return Math.floor(Date.now() / 1000); }

async function register(remoteAddr: string) {
  const { publicKeyRaw, privateSeed } = generateKeypair();
  const pubkey = publicKeyRaw.toString("base64");
  const capabilities = ["llm.reasoning"];
  const model_class = "test/model";
  const t = ts();
  const sig = signPayload({ capabilities, model_class, pubkey, ts: t }, privateSeed);
  const res = await app.inject({
    method: "POST", url: "/v1/agents/register", remoteAddress: remoteAddr,
    payload: { protocol_version: PROTOCOL_VERSION, pubkey, model_class, capabilities, ts: t, sig },
  });
  assert.equal(res.statusCode, 200);
  return { body: res.json() as Record<string, unknown>, privateSeed, pubkey, model_class, capabilities };
}

async function submit(agentId: string, key: string | null, privateSeed: Buffer, p = 0.7) {
  const payload = { answers: [{ q_id: "q1", p, rationale: "test" }] };
  const t = ts();
  const sig = signPayload({ agent_id: agentId, payload_hash: hashCanonical(payload), task_id: "t_wu_t1", ts: t }, privateSeed);
  return app.inject({
    method: "POST", url: "/v1/results",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    payload: { protocol_version: PROTOCOL_VERSION, agent_id: agentId, task_id: "t_wu_t1", payload, template_version: "test@0", ts: t, sig },
  });
}

test("register issues an API key and enables default missions", async () => {
  const { body } = await register("10.0.0.1");
  assert.match(String(body.api_key), /^swk_/);
  assert.deepEqual(body.enabled_missions, ["test-slate"]);
  // key is stored hashed, never in plaintext
  const stored = db.prepare("SELECT key_hash FROM api_keys").all() as { key_hash: string }[];
  assert.ok(stored.every((r) => r.key_hash !== body.api_key && r.key_hash.length === 64));
});

test("work and results require a valid key bound to the agent", async () => {
  const a = await register("10.0.0.2");
  const agentId = String(a.body.agent_id);
  const key = String(a.body.api_key);

  const noKey = await app.inject({ method: "GET", url: `/v1/work?agent_id=${agentId}` });
  assert.equal(noKey.statusCode, 401);
  assert.equal(noKey.json().error.code, "BAD_KEY");

  const withKey = await app.inject({
    method: "GET", url: `/v1/work?agent_id=${agentId}`, headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(withKey.statusCode, 200);
  assert.equal(withKey.json().tasks.length, 1);

  // someone else's key must not authorize this agent
  const b = await register("10.0.0.3");
  const wrongKey = await submit(agentId, String(b.body.api_key), a.privateSeed);
  assert.equal(wrongKey.statusCode, 401);

  const ok = await submit(agentId, key, a.privateSeed);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().accepted, true);
});

test("signed re-register rotates the key; old key is revoked", async () => {
  const a = await register("10.0.0.4");
  const agentId = String(a.body.agent_id);
  const oldKey = String(a.body.api_key);

  // register again with the same pubkey (same signing key = proof of identity)
  const t = ts();
  const sig = signPayload({ capabilities: a.capabilities, model_class: a.model_class, pubkey: a.pubkey, ts: t }, a.privateSeed);
  const res = await app.inject({
    method: "POST", url: "/v1/agents/register", remoteAddress: "10.0.0.4",
    payload: { protocol_version: PROTOCOL_VERSION, pubkey: a.pubkey, model_class: a.model_class, capabilities: a.capabilities, ts: t, sig },
  });
  assert.equal(res.statusCode, 200);
  const newKey = String(res.json().api_key);
  assert.notEqual(newKey, oldKey);
  assert.equal(res.json().agent_id, agentId);

  const revoked = await submit(agentId, oldKey, a.privateSeed);
  assert.equal(revoked.statusCode, 401);
  const fresh = await submit(agentId, newKey, a.privateSeed);
  assert.equal(fresh.statusCode, 200);
});

test("per-key burst limit trips (results: 5/min in this test)", async () => {
  const a = await register("10.0.0.5");
  const agentId = String(a.body.agent_id);
  const key = String(a.body.api_key);
  let limited = 0;
  for (let i = 0; i < 8; i++) {
    const res = await submit(agentId, key, a.privateSeed, 0.5 + i * 0.01);
    if (res.statusCode === 429) {
      limited += 1;
      assert.equal(res.json().error.code, "RATE_LIMITED");
    }
  }
  assert.ok(limited >= 3, `expected >=3 rate-limited responses, got ${limited}`);
});

test("per-key daily quota trips (work: 8/day in this test)", async () => {
  const a = await register("10.0.0.6");
  const agentId = String(a.body.agent_id);
  const key = String(a.body.api_key);
  let quotaHit = false;
  for (let i = 0; i < 12; i++) {
    const res = await app.inject({
      method: "GET", url: `/v1/work?agent_id=${agentId}`, headers: { authorization: `Bearer ${key}` },
    });
    if (res.statusCode === 429 && res.json().error.code === "QUOTA_EXCEEDED") { quotaHit = true; break; }
  }
  assert.ok(quotaHit, "daily work quota never tripped");
});
