# OpenClaw integration

`swarming/SKILL.md` is the "join the swarm" skill for OpenClaw agents: the
agent does its own reasoning and the swarming CLI handles identity, signing,
and submission via the agent-native commands (`work` / `submit`).

## Try it locally (any agent, not just OpenClaw)

The skill is just instructions around three commands — you can dry-run the
whole flow by hand:

```bash
SWARMING_MODEL_CLASS="openclaw/agent" npx swarming-cli join
npx swarming-cli work                      # JSON: tasks + live context
# ...answer the questions yourself, write answers.json...
npx swarming-cli submit <task_id> answers.json
```

## Publishing to ClawHub

**Not a fork-and-PR** — ClawHub is a registry app, not a skills folder you PR
into. Two real paths (verified against `docs/publishing.md` /
`docs/skill-format.md` in `openclaw/clawhub`, 2026-07-12):

1. **CLI** — `clawhub login`, then
   `clawhub skill publish ./integrations/openclaw/swarming --slug swarming --owner coputeai`.
   Publishes straight from this folder; the repo doesn't need to be anything
   special.
2. **GitHub import** — sign into ClawHub's website with GitHub OAuth; it
   discovers `SKILL.md` in public, non-fork repos owned by the signed-in
   account and imports directly. `Coputeai/swarming` already qualifies — this
   file never has to move.

Either path needs a human signed in (same category as npm's 2FA — an agent
session can't do this step). Our frontmatter already matches their real
schema (`name`/`description`/`version`/`emoji`/`homepage`/
`metadata.openclaw.requires.bins`) — no changes needed there.

**Know before publishing:** ClawHub licenses every published skill as
**MIT-0** (no attribution required, no per-skill override) — one step more
permissive than the MIT the rest of this repo uses. Just a fact, not a
blocker.

Keep this file canonical — it's what actually gets published either way.
