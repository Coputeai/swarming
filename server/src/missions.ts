// Loads declarative mission manifests from the repo's missions/ directory and
// syncs them into the db. The server knows generator/resolver *types*, never
// mission specifics.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const MISSIONS_DIR = process.env.SWARMING_MISSIONS_DIR ?? join(here, "..", "..", "missions");

export const GENERATOR_WHITELIST = ["question-slate"] as const;
export const RESOLVER_WHITELIST = ["coingecko-close", "binance-close", "manual-dev"] as const;

export interface MissionManifest {
  id: string;
  version: string;
  author: string;
  title: string;
  default?: boolean;
  pattern: "broadcast" | "shard";
  verification: { mode: "oracle" | "quorum" | "peer"; resolver: string };
  generator: string;
  capabilities: string[];
  schedule: string;
  window_hours: number;
  points: { base: number; daily_budget: number };
}

export function loadManifests(): MissionManifest[] {
  const manifests: MissionManifest[] = [];
  for (const entry of readdirSync(MISSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(MISSIONS_DIR, entry.name, "mission.yaml");
    if (!existsSync(file)) continue;
    const m = parseYaml(readFileSync(file, "utf8")) as MissionManifest;
    if (m.id !== entry.name) throw new Error(`mission id '${m.id}' != directory '${entry.name}'`);
    if (!GENERATOR_WHITELIST.includes(m.generator as never)) {
      throw new Error(`mission ${m.id}: generator '${m.generator}' not in whitelist`);
    }
    if (!RESOLVER_WHITELIST.includes(m.verification?.resolver as never)) {
      throw new Error(`mission ${m.id}: resolver '${m.verification?.resolver}' not in whitelist`);
    }
    manifests.push(m);
  }
  return manifests;
}

export function syncMissions(db: DatabaseSync): MissionManifest[] {
  const manifests = loadManifests();
  const upsert = db.prepare(
    `INSERT INTO missions (mission_id, version, manifest_json, status) VALUES (?, ?, ?, 'active')
     ON CONFLICT(mission_id) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json`,
  );
  for (const m of manifests) upsert.run(m.id, m.version, JSON.stringify(m));
  return manifests;
}

export function getManifest(db: DatabaseSync, missionId: string): MissionManifest | null {
  const row = db.prepare("SELECT manifest_json FROM missions WHERE mission_id = ?").get(missionId) as
    | { manifest_json: string }
    | undefined;
  return row ? (JSON.parse(row.manifest_json) as MissionManifest) : null;
}
