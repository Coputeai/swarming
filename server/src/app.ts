import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import {
  agentIdFromPubkey,
  hashCanonical,
  nameFromPubkey,
  verifyPayload,
  PROTOCOL_VERSION,
  TS_WINDOW_SECONDS,
  RATIONALE_MAX_CHARS,
  TIER_NAMES,
  type Answer,
  type ErrorCode,
  type Question,
  type Task,
} from "../../packages/protocol/src/index.ts";
import { logEvent } from "./db.ts";
import { getManifest } from "./missions.ts";

const SITE_BASE = process.env.SWARMING_SITE_BASE ?? "https://swarming.copute.ai";

function err(reply: FastifyReply, status: number, code: ErrorCode, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

function freshTs(ts: unknown): boolean {
  if (typeof ts !== "number") return false;
  return Math.abs(Date.now() / 1000 - ts) <= TS_WINDOW_SECONDS;
}

// In-memory per-IP rate limiting (v0; nginx adds another layer in prod).
function makeLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; start: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.start > windowMs) {
      hits.set(ip, { n: 1, start: now });
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}

export function buildApp(db: DatabaseSync): FastifyInstance {
  const app = Fastify({ logger: false });
  const registerLimit = makeLimiter(5, 24 * 60 * 60 * 1000);
  const submitLimit = makeLimiter(20, 60 * 1000);

  app.post("/v1/agents/register", async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    if (b?.protocol_version !== PROTOCOL_VERSION) return err(reply, 400, "BAD_REQUEST", "unsupported protocol_version");
    if (!freshTs(b.ts)) return err(reply, 400, "STALE_TS", "timestamp outside allowed window");
    const pubkeyB64 = String(b.pubkey ?? "");
    const pubkey = Buffer.from(pubkeyB64, "base64");
    if (pubkey.length !== 32) return err(reply, 400, "BAD_REQUEST", "pubkey must be raw 32-byte ed25519, base64");
    const signed = { capabilities: b.capabilities, model_class: b.model_class, pubkey: pubkeyB64, ts: b.ts };
    if (!verifyPayload(signed, String(b.sig ?? ""), pubkey)) return err(reply, 401, "BAD_SIG", "signature invalid");

    const existing = db.prepare("SELECT * FROM agents WHERE pubkey = ?").get(pubkeyB64) as Record<string, unknown> | undefined;
    if (existing) {
      db.prepare("UPDATE agents SET last_seen_at = ? WHERE agent_id = ?").run(new Date().toISOString(), existing.agent_id as string);
      return registerResponse(db, existing);
    }

    if (!registerLimit(req.ip)) return err(reply, 429, "RATE_LIMITED", "too many registrations from this IP today");

    const agentId = agentIdFromPubkey(pubkey);
    let name = nameFromPubkey(pubkey);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
    const agentNumber = count + 1;
    if (db.prepare("SELECT 1 FROM agents WHERE name = ?").get(name)) name = `${name}-${agentNumber}`;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents (agent_id, pubkey, name, agent_number, model_class, capabilities_json, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, pubkeyB64, name, agentNumber, String(b.model_class ?? "unknown"), JSON.stringify(b.capabilities ?? []), now, now);

    // Auto-enable default missions; everything else is opt-in (RoE 3)
    const missions = db.prepare("SELECT mission_id, manifest_json FROM missions WHERE status = 'active'").all() as {
      mission_id: string;
      manifest_json: string;
    }[];
    for (const m of missions) {
      if ((JSON.parse(m.manifest_json) as { default?: boolean }).default) {
        db.prepare("INSERT OR REPLACE INTO subscriptions (agent_id, mission_id, enabled, updated_at) VALUES (?, ?, 1, ?)").run(
          agentId, m.mission_id, now,
        );
      }
    }
    logEvent(db, "join_completed", { ip: req.ip, agent_id: agentId, payload: { model_class: b.model_class } });
    const row = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as Record<string, unknown>;
    return registerResponse(db, row);
  });

  function registerResponse(database: DatabaseSync, agent: Record<string, unknown>) {
    const enabled = (database
      .prepare("SELECT mission_id FROM subscriptions WHERE agent_id = ? AND enabled = 1")
      .all(agent.agent_id as string) as { mission_id: string }[]).map((r) => r.mission_id);
    return {
      agent_id: agent.agent_id,
      name: agent.name,
      agent_number: agent.agent_number,
      profile_url: `${SITE_BASE}/a/${agent.name}`,
      enabled_missions: enabled,
    };
  }

  app.get("/v1/missions", async () => {
    const rows = db.prepare("SELECT manifest_json, status FROM missions").all() as { manifest_json: string; status: string }[];
    return rows.map((r) => {
      const m = JSON.parse(r.manifest_json);
      return {
        id: m.id, version: m.version, title: m.title, pattern: m.pattern,
        verification_mode: m.verification.mode, points_base: m.points.base,
        default: Boolean(m.default), status: r.status,
      };
    });
  });

  app.post("/v1/missions/subscribe", async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    if (b?.protocol_version !== PROTOCOL_VERSION) return err(reply, 400, "BAD_REQUEST", "unsupported protocol_version");
    if (!freshTs(b.ts)) return err(reply, 400, "STALE_TS", "timestamp outside allowed window");
    const agent = db.prepare("SELECT pubkey FROM agents WHERE agent_id = ?").get(String(b.agent_id ?? "")) as { pubkey: string } | undefined;
    if (!agent) return err(reply, 404, "UNKNOWN_AGENT", "agent not registered");
    const signed = { agent_id: b.agent_id, enabled: b.enabled, mission_id: b.mission_id, ts: b.ts };
    if (!verifyPayload(signed, String(b.sig ?? ""), Buffer.from(agent.pubkey, "base64"))) {
      return err(reply, 401, "BAD_SIG", "signature invalid");
    }
    if (!db.prepare("SELECT 1 FROM missions WHERE mission_id = ?").get(String(b.mission_id ?? ""))) {
      return err(reply, 404, "BAD_REQUEST", "unknown mission");
    }
    db.prepare("INSERT OR REPLACE INTO subscriptions (agent_id, mission_id, enabled, updated_at) VALUES (?, ?, ?, ?)").run(
      String(b.agent_id), String(b.mission_id), b.enabled ? 1 : 0, new Date().toISOString(),
    );
    return { ok: true };
  });

  app.get("/v1/work", async (req, reply) => {
    const agentId = String((req.query as Record<string, unknown>).agent_id ?? "");
    const agentRow = db.prepare("SELECT capabilities_json FROM agents WHERE agent_id = ?").get(agentId) as
      | { capabilities_json: string } | undefined;
    if (!agentRow) return err(reply, 404, "UNKNOWN_AGENT", "agent not registered");
    const agentCaps = new Set(JSON.parse(agentRow.capabilities_json) as string[]);
    const now = new Date().toISOString();
    const rows = db.prepare(
      `SELECT w.* FROM workunits w
       JOIN subscriptions s ON s.mission_id = w.mission_id AND s.agent_id = ? AND s.enabled = 1
       WHERE w.status = 'open' AND w.closes_at > ?`,
    ).all(agentId, now) as Record<string, string>[];
    logEvent(db, "work_pulled", { ip: req.ip, agent_id: agentId, payload: { n: rows.length } });

    const tasks: Task[] = [];
    for (const w of rows) {
      const manifest = getManifest(db, w.mission_id)!;
      // capability gate (the skill interface): an agent only receives work whose
      // mission requires capabilities it has declared. New skills/missions become
      // available simply by agents advertising the matching capability.
      if (!(manifest.capabilities ?? []).every((c) => agentCaps.has(c))) continue;
      const submitted = Boolean(db.prepare("SELECT 1 FROM results WHERE agent_id = ? AND workunit_id = ?").get(agentId, w.workunit_id));
      tasks.push({
        task_id: `t_${w.workunit_id}`,
        mission_id: w.mission_id,
        workunit_id: w.workunit_id,
        pattern: manifest.pattern,
        verification: manifest.verification.mode,
        payload: JSON.parse(w.payload_json),
        prompt_template_version: `${manifest.id}/prompts@${manifest.version}`,
        deadline: w.closes_at,
        points_base: manifest.points.base,
        already_submitted: submitted,
      });
    }
    return { tasks };
  });

  app.post("/v1/results", async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    if (b?.protocol_version !== PROTOCOL_VERSION) return err(reply, 400, "BAD_REQUEST", "unsupported protocol_version");
    if (!freshTs(b.ts)) return err(reply, 400, "STALE_TS", "timestamp outside allowed window");
    if (!submitLimit(req.ip)) return err(reply, 429, "RATE_LIMITED", "too many submissions, slow down");

    const agent = db.prepare("SELECT pubkey FROM agents WHERE agent_id = ?").get(String(b.agent_id ?? "")) as { pubkey: string } | undefined;
    if (!agent) return err(reply, 404, "UNKNOWN_AGENT", "agent not registered");

    const taskId = String(b.task_id ?? "");
    const workunitId = taskId.startsWith("t_") ? taskId.slice(2) : "";
    const wu = db.prepare("SELECT * FROM workunits WHERE workunit_id = ?").get(workunitId) as Record<string, string> | undefined;
    if (!wu) return err(reply, 404, "BAD_REQUEST", "unknown task");
    if (wu.status !== "open" || wu.closes_at <= new Date().toISOString()) {
      return err(reply, 409, "WORK_CLOSED", "this workunit is closed");
    }
    const enabled = db.prepare("SELECT 1 FROM subscriptions WHERE agent_id = ? AND mission_id = ? AND enabled = 1").get(
      String(b.agent_id), wu.mission_id,
    );
    if (!enabled) return err(reply, 403, "NOT_ENABLED", "agent has not enabled this mission");

    const signed = { agent_id: b.agent_id, payload_hash: hashCanonical(b.payload), task_id: taskId, ts: b.ts };
    if (!verifyPayload(signed, String(b.sig ?? ""), Buffer.from(agent.pubkey, "base64"))) {
      return err(reply, 401, "BAD_SIG", "signature invalid");
    }

    const questions = (JSON.parse(wu.payload_json) as { questions: Question[] }).questions;
    const answers = (b.payload as { answers?: Answer[] })?.answers;
    const validation = validateAnswers(questions, answers);
    if (validation) return err(reply, 400, "BAD_REQUEST", validation);

    const prev = db.prepare("SELECT id, replaced_count FROM results WHERE agent_id = ? AND workunit_id = ?").get(
      String(b.agent_id), workunitId,
    ) as { id: number; replaced_count: number } | undefined;
    const now = new Date().toISOString();
    if (prev) {
      db.prepare("UPDATE results SET payload_json = ?, template_version = ?, submitted_at = ?, replaced_count = ? WHERE id = ?").run(
        JSON.stringify(b.payload), String(b.template_version ?? ""), now, prev.replaced_count + 1, prev.id,
      );
    } else {
      db.prepare(
        "INSERT INTO results (agent_id, workunit_id, payload_json, template_version, submitted_at) VALUES (?, ?, ?, ?, ?)",
      ).run(String(b.agent_id), workunitId, JSON.stringify(b.payload), String(b.template_version ?? ""), now);
    }
    logEvent(db, "result_submitted", { ip: req.ip, agent_id: String(b.agent_id), payload: { workunit_id: workunitId, replaced: Boolean(prev) } });
    return { accepted: true, replaced: Boolean(prev), scoring_at: wu.resolve_at };
  });

  app.get("/v1/agents/:agent_id", async (req, reply) => {
    const { agent_id } = req.params as { agent_id: string };
    const a = db.prepare("SELECT * FROM agents WHERE agent_id = ? OR name = ?").get(agent_id, agent_id) as
      | Record<string, unknown>
      | undefined;
    if (!a) return err(reply, 404, "UNKNOWN_AGENT", "no such agent");
    const enabled = (db.prepare("SELECT mission_id FROM subscriptions WHERE agent_id = ? AND enabled = 1").all(a.agent_id as string) as {
      mission_id: string;
    }[]).map((r) => r.mission_id);
    return {
      agent_id: a.agent_id, name: a.name, agent_number: a.agent_number, model_class: a.model_class,
      created_at: a.created_at, skill: Number((a.skill as number).toFixed(4)), points: a.points,
      streak: a.streak, tier: TIER_NAMES[a.tier_index as number], scored_count: a.scored_count,
      enabled_missions: enabled,
    };
  });

  app.get("/v1/stats", async () => {
    const agents = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
    const results = (db.prepare("SELECT COUNT(*) AS n FROM results").get() as { n: number }).n;
    const scored = (db.prepare("SELECT COUNT(*) AS n FROM scores").get() as { n: number }).n;
    return { agents, results, scored };
  });

  return app;
}

function validateAnswers(questions: Question[], answers: Answer[] | undefined): string | null {
  if (!Array.isArray(answers)) return "payload.answers must be an array";
  const byId = new Map(answers.map((a) => [a.q_id, a]));
  if (byId.size !== answers.length) return "duplicate q_id in answers";
  for (const q of questions) {
    const a = byId.get(q.q_id);
    if (!a) return `missing answer for ${q.q_id}`;
    if (typeof a.rationale !== "string" || a.rationale.length > RATIONALE_MAX_CHARS) {
      return `${q.q_id}: rationale required, max ${RATIONALE_MAX_CHARS} chars`;
    }
    if (q.type === "binary") {
      if (typeof a.p !== "number" || a.p < 0 || a.p > 1) return `${q.q_id}: binary answer needs p in [0,1]`;
    } else {
      if (typeof a.choice !== "string" || !q.choices.includes(a.choice)) return `${q.q_id}: choice must be one of the listed options`;
    }
  }
  if (answers.length !== questions.length) return "answers for unknown q_ids present";
  return null;
}
