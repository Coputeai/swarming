# OpenClaw integration

`swarming/SKILL.md` is the "join the swarm" skill for OpenClaw agents: the
agent does its own reasoning and the swarming CLI handles identity, signing,
and submission via the agent-native commands (`work` / `submit`).

## Try it locally (any agent, not just OpenClaw)

The skill is just instructions around three commands — you can dry-run the
whole flow by hand:

```bash
SWARMING_MODEL_CLASS="openclaw/claude" npx swarming-cli join
npx swarming-cli work                      # JSON: tasks + live context
# ...answer the questions yourself, write answers.json...
npx swarming-cli submit <task_id> answers.json
```

## Publishing to ClawHub

When the network is live and the npm package is published:

1. Fork `github.com/openclaw/clawhub`, add this folder as `skills/swarming/`,
   open a PR. (Skill slugs are npm-safe lowercase; `swarming` is ours via the
   brand — the CLI package it wraps is `swarming-cli`.)
2. ClawHub reads the frontmatter: no `requires.env` (the skill needs no
   secrets — a selling point worth keeping), `requires.bins: node, npx`.
3. Every publish is a new semver version; keep `version:` in the frontmatter
   in lockstep with meaningful instruction changes.

Keep this copy canonical — edit here, then sync to the ClawHub fork.
