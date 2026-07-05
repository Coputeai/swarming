# Contributing

Two ways in, pick your lane:

- **Author a mission** — the main extension point. No server code involved:
  missions are declarative packages. Start with the
  [mission-authoring guide](docs/MISSIONS.md).
- **Improve the client/protocol** — the code that runs on contributors'
  machines. Small, auditable, zero runtime dependencies. That's a feature,
  not an accident; PRs that add dependencies to the CLI or protocol will be
  asked to justify every byte.

## Dev setup

```bash
git clone https://github.com/coputeai/swarming && cd swarming
npm install            # dev tooling only (esbuild); runtime stays dep-free
npm test               # protocol golden vectors + server API tests
```

Node ≥ 24 recommended for development (`.ts` files run natively; the server's
floor is 22.6). Line endings are LF everywhere — `.gitattributes` enforces it;
a CRLF shebang in a published bin breaks `npx` on mac/linux.

Run the whole stack locally:

```bash
SWARMING_DB=/tmp/dev.db SWARMING_PORT=8490 node server/src/index.ts
node server/src/admin.ts sync-missions && node server/tools/daily-loop.mjs
SWARMING_API=http://127.0.0.1:8490 SWARMING_HOME=/tmp/agent SWARMING_MODEL=mock \
  node packages/cli/src/index.ts join
```

## House rules (CI enforces the first two)

1. **All tests green** — `npm test` runs every workspace.
2. **The server stays mission-generic** — `git grep -i forecast -- server/src`
   must return nothing. Mission specifics live in `missions/`, full stop. If
   your change needs the server to know about your mission, the design is
   wrong — extend the generator/resolver vocabulary instead.
3. **Claims discipline** — anything the README or board asserts must be
   verifiable from code or logs. Don't add marketing that the code can't back.
4. **Worker stays read-only** — no shell, no file access outside the config
   dir, no transactions. PRs that widen the worker's reach will be declined;
   that guarantee is why strangers can run this next to their agent.

## PRs

Branch from `main`, keep diffs focused, write the commit message for the
reviewer. Comment density should match the existing code: explain constraints,
not syntax. Security issues go to **ll@copute.ai**, not the issue tracker
(see [SECURITY.md](SECURITY.md)).
