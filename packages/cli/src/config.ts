// Agent config lives in one directory the worker owns. The ONLY secret here
// is the agent's own ed25519 key. Model API keys are read from env at call
// time and never written to disk or sent to the network.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeypair, publicKeyRawFromSeed } from "../../protocol/src/index.ts";

export const API_BASE = process.env.SWARMING_API ?? "https://swarming.copute.ai/api";

export function configDir(): string {
  return process.env.SWARMING_HOME ?? join(homedir(), ".swarming");
}

export function loadOrCreateKeypair(): { publicKeyRaw: Buffer; privateSeed: Buffer; created: boolean } {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "agent.key");
  if (existsSync(keyPath)) {
    const seed = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    return { publicKeyRaw: publicKeyRawFromSeed(seed), privateSeed: seed, created: false };
  }
  const { publicKeyRaw, privateSeed } = generateKeypair();
  writeFileSync(keyPath, privateSeed.toString("base64") + "\n");
  try { chmodSync(keyPath, 0o600); } catch { /* windows */ }
  return { publicKeyRaw, privateSeed, created: true };
}

export function loadIdentity(): { agent_id: string; name: string } | null {
  const p = join(configDir(), "identity.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function saveIdentity(identity: { agent_id: string; name: string }): void {
  writeFileSync(join(configDir(), "identity.json"), JSON.stringify(identity, null, 2) + "\n");
}

export const SWARMING_MD_VERSION = "swarming-md@1.0.0";

const SWARMING_MD_TEMPLATE = `<!-- ${SWARMING_MD_VERSION} — your agent's strategy file. Edit freely; it shapes
     how YOUR agent researches and answers. Shareable. Max 8KB used. -->

# My agent's strategy

- Be calibrated: extreme probabilities (under 0.05 or over 0.95) only with
  strong evidence. Overconfidence is penalized quadratically.
- Prefer base rates over narratives. Recent headlines are usually priced in.
- One-line rationales: state the single strongest reason, not a summary.
`;

export function ensureSwarmingMd(): string {
  const p = join(configDir(), "SWARMING.md");
  if (!existsSync(p)) writeFileSync(p, SWARMING_MD_TEMPLATE);
  let text = readFileSync(p, "utf8");
  if (Buffer.byteLength(text, "utf8") > 8192) {
    console.error("warning: SWARMING.md exceeds 8KB — truncating for the prompt");
    text = text.slice(0, 8192);
  }
  return text;
}
