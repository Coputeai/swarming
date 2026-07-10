import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SWARMING_DB ?? join(here, "..", "data", "swarming.db");

export function openDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      pubkey TEXT UNIQUE NOT NULL,
      name TEXT UNIQUE NOT NULL,
      agent_number INTEGER NOT NULL,
      model_class TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      skill REAL NOT NULL DEFAULT 0.5,
      points INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      tier_index INTEGER NOT NULL DEFAULT 0,
      scored_count INTEGER NOT NULL DEFAULT 0,
      last_scored_date TEXT
    );
    CREATE TABLE IF NOT EXISTS missions (
      mission_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      agent_id TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, mission_id)
    );
    CREATE TABLE IF NOT EXISTS workunits (
      workunit_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      published_at TEXT NOT NULL,
      closes_at TEXT NOT NULL,
      resolve_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      outcome_json TEXT,
      consensus_json TEXT,
      rounds INTEGER NOT NULL DEFAULT 1,
      current_round INTEGER NOT NULL DEFAULT 1,
      round_started_at TEXT,
      round_closes_at TEXT,
      round_aggregates_json TEXT
    );
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      workunit_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      template_version TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      replaced_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (agent_id, workunit_id)
    );
    CREATE TABLE IF NOT EXISTS scores (
      agent_id TEXT NOT NULL,
      workunit_id TEXT NOT NULL,
      brier REAL NOT NULL,
      acc REAL NOT NULL,
      skill_after REAL NOT NULL,
      points INTEGER NOT NULL,
      streak_after INTEGER NOT NULL,
      PRIMARY KEY (agent_id, workunit_id)
    );
    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      workunit_id TEXT,
      mission_id TEXT,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      finalized_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys (agent_id);
    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      ip TEXT,
      agent_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT
    );
  `);
  // Migrate existing databases by adding round columns if absent.
  for (const stmt of [
    "ALTER TABLE workunits ADD COLUMN rounds INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE workunits ADD COLUMN current_round INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE workunits ADD COLUMN round_started_at TEXT",
    "ALTER TABLE workunits ADD COLUMN round_closes_at TEXT",
    "ALTER TABLE workunits ADD COLUMN round_aggregates_json TEXT",
    // Agent lifecycle: status='deceased' means the agent never acts again.
    // Its scored history stays — public numbers must remain reproducible.
    "ALTER TABLE agents ADD COLUMN deceased_at TEXT",
    "ALTER TABLE agents ADD COLUMN epitaph TEXT",
  ]) {
    try { db.exec(stmt); } catch { /* column already exists */ }
  }

  return db;
}

export function logEvent(
  db: DatabaseSync,
  kind: string,
  fields: { ip?: string | null; agent_id?: string | null; payload?: unknown },
): void {
  db.prepare("INSERT INTO raw_events (ts, ip, agent_id, kind, payload_json) VALUES (?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    fields.ip ?? null,
    fields.agent_id ?? null,
    kind,
    fields.payload === undefined ? null : JSON.stringify(fields.payload),
  );
}
