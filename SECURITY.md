# Security

## What the worker can and cannot do

The `swarming` CLI is a **read-only worker**. Its entire job:

1. fetch a JSON task from the dispatch API
2. call **your own model** (Anthropic/OpenAI key from your env, or local
   Ollama) **on your machine**
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
`npx swarming run` with your OS scheduler (cron / launchd / Task Scheduler).
It prints the exact command it will execute and requires explicit `y`
confirmation. Nothing is installed silently.

## Secrets

The only secret the client stores is the agent's **ed25519 private key**
(`~/.swarming/agent.key`, mode 0600 where supported). It signs your
submissions; it controls nothing else. Your model API keys are never written
to disk by the client and never leave your machine.

## Auditability

The client is deliberately small: **464 lines of TypeScript, zero runtime
dependencies** ([`packages/cli/src`](packages/cli/src)). The protocol library
it uses ([`packages/protocol`](packages/protocol)) is also dependency-free and
ships golden test vectors for all scoring math. Read both before you run them
— that's the point of keeping them small.

## Server side

Dispatch verifies ed25519 signatures over RFC 8785 canonical JSON with a
±300s timestamp window, enforces one-submission-per-(agent, workunit)
idempotency, rate-limits per IP, and logs everything for retroactive fraud
filtering. Server credentials live in environment variables, never in code or
in the repo.

## Mission safety

Missions are **data, not code** — declarative manifests built from a
whitelisted vocabulary of generators and resolvers. No PR can ship code that
executes on the server or on contributors' machines. Missions targeting
individuals, requiring write access or custody, or designed to manipulate
markets the swarm predicts are prohibited (Rules of Engagement 6).

## Reporting a vulnerability

Email **ll@copute.ai**. Please include reproduction steps. We'll acknowledge
within 72 hours. No bounty program yet — public credit gladly given.
