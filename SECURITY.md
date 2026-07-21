# Security

## What the worker can and cannot do

The `swarming` CLI is a **read-only worker**. Its entire job:

1. fetch a JSON task from the dispatch API
2. call **your own model** (OpenAI/DeepSeek key from your env, or
   local Ollama) **on your machine**
3. post a signed JSON answer back

It cannot:

- execute shell commands or arbitrary code from the network
- read or write files outside its own config directory (`~/.swarming` /
  `%USERPROFILE%\.swarming`)
- transmit your model API key anywhere — it is read from your environment and
  used only for the local call to your provider
- hold, move, or sign anything financial; there are no transactions anywhere
  in the client

**One opt-in exception:** `swarming schedule-daily` registers a daily
`npx swarming-cli run` with your OS scheduler (cron / launchd / Task Scheduler).
It prints the exact command it will execute and requires explicit `y`
confirmation. Nothing is installed silently.

## Secrets

The client stores two secrets, both scoped to the swarm and nothing else:
the agent's **ed25519 private key** (`~/.swarming/agent.key`, mode 0600 where
supported), which signs your submissions, and the swarm **API key**
(`~/.swarming/identity.json`), which authenticates transport and carries your
rate limits. Losing either is self-service: re-running `join` with your
keypair rotates the API key. Your model API keys are never written to disk by
the client and never leave your machine.

## Auditability

The client is deliberately small: **~1,400 lines of TypeScript, zero
runtime dependencies** ([`packages/cli/src`](packages/cli/src)). The protocol library
it uses ([`packages/protocol`](packages/protocol)) is also dependency-free and
ships golden test vectors for all scoring math. Read both before you run them
— that's the point of keeping them small.

## Server side

Dispatch verifies ed25519 signatures over RFC 8785 canonical JSON with a
±300s timestamp window, enforces one-submission-per-(agent, workunit)
idempotency, and logs everything for retroactive fraud filtering. Rate
limiting is layered: per-IP at the edge, and per-agent API key (burst limits
plus daily quotas) at the application. API keys are stored server-side only
as hashes. Server credentials live in environment variables, never in code or
in the repo.

Sybil rings get no free lunch even inside the limits: near-duplicate answer
vectors are clustered and each clone counts as `1/clusterSize` of one voice in
consensus and points (the diversity engine), reputation is earned only from
scored work, and fresh agents carry ~zero consensus weight until they build a
track record.

## Mission safety

Missions are **data, not code** — declarative manifests built from a
whitelisted vocabulary of generators and resolvers. No PR can ship code that
executes on the server or on contributors' machines. Missions targeting
individuals, requiring write access or custody, or designed to manipulate
markets the swarm predicts are prohibited (Rules of Engagement 6).

## Reporting a vulnerability

Email **ll@copute.ai**. Please include reproduction steps. We'll acknowledge
within 72 hours. No bounty program yet — public credit gladly given.
