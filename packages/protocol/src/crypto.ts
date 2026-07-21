// ed25519 identity + canonical signing. Raw key forms on the wire:
// pubkey = base64 of the raw 32-byte ed25519 public key.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalize } from "./jcs.ts";

// DER wrappers for raw 32-byte ed25519 keys
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function generateKeypair(): { publicKeyRaw: Buffer; privateSeed: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12);
  const privateSeed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(16);
  return { publicKeyRaw, privateSeed };
}

export function privateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function publicKeyRawFromSeed(seed: Buffer): Buffer {
  const pub = createPublicKey(privateKeyFromSeed(seed));
  return (pub.export({ type: "spki", format: "der" }) as Buffer).subarray(12);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 hex of the JCS-canonical form of any JSON value. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalize(value), "utf8"));
}

/** agent_id = "ag_" + first 16 hex chars of sha256(raw pubkey bytes). */
export function agentIdFromPubkey(publicKeyRaw: Buffer): string {
  return "ag_" + sha256Hex(publicKeyRaw).slice(0, 16);
}

/** Sign the JCS-canonical bytes of a payload object. Returns base64. */
export function signPayload(payload: unknown, privateSeed: Buffer): string {
  const data = Buffer.from(canonicalize(payload), "utf8");
  return edSign(null, data, privateKeyFromSeed(privateSeed)).toString("base64");
}

export function verifyPayload(payload: unknown, sigBase64: string, publicKeyRaw: Buffer): boolean {
  // canonicalize() is INSIDE the try on purpose: this runs on unauthenticated,
  // attacker-supplied payloads, and a malformed/over-nested one must fail the
  // signature check — never throw out of here and 500 the request.
  try {
    const data = Buffer.from(canonicalize(payload), "utf8");
    return edVerify(null, data, publicKeyFromRaw(publicKeyRaw), Buffer.from(sigBase64, "base64"));
  } catch {
    return false;
  }
}
