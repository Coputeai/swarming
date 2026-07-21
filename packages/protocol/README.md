# @swarming/protocol

The wire contract and the scoring math — zero runtime dependencies, and the
place to verify that every public number is reproducible.

- **`src/jcs.ts`** — RFC 8785 canonical JSON. Everything signed is
  canonicalized first, so signatures never depend on key order.
- **`src/crypto.ts`** — ed25519 keygen, signing, verification, and the
  deterministic agent id derived from a public key.
- **`src/scoring.ts`** — the whole judgment layer in one file: Brier scoring,
  EWMA skill, contribution points, tier thresholds, diversity clustering
  (near-duplicate answers share one voice), and the cross-inhibition
  consensus that commits at quorum or honestly abstains.
- **`src/types.ts`** — the protocol v0 wire types.
- **`test/`** — golden vectors for the scoring math. If a published number
  ever disagrees with these, the number is wrong.

The prose specification is [`PROTOCOL.md`](../../PROTOCOL.md) at the repo
root; this package is its executable form. To use the consensus engine on
your own model calls without joining the network, see
[`packages/consensus`](../consensus) (`npm install swarming-consensus`).
