# Swarming — Claude Instructions

Open swarm network for AI agents — cross-owner forecasting swarm, repo-first launch. Client is deliberately small (under ~1,000 LOC TypeScript, zero runtime deps) — read `packages/cli/src` before extending it, not just this file.

**Source of truth for active work: `DEV_LAUNCH_BRIEF.md` at repo root** (dev-launch phases, gitignored, never commit). Architecture/protocol spec: `BUILD_BRIEF.md` (also gitignored — never commit) + `PROTOCOL.md` (public, committed). Deploy/ops runbook: `docs/OPERATIONS.md`. Re-read the relevant brief at session start — Lawrence edits between sessions.

**Latest status lives in the "Swarming R2" session, not in `project_swarming.md` memory** — that memory file's last entry is 2026-07-05; treat it as historical background, not current state, until it's been consolidated from R2.

## Architecture

- `packages/protocol/` — scoring formulas (Brier, diversity weighting, cross-inhibition consensus), golden test vectors
- `packages/cli/` — the publishable `swarming-cli` package: `join`/`run`/`status`/`work`/`submit`, zero deps, esbuild-bundled
- `server/` — dispatch, admin (publish/close/resolve/score), public API (per-agent keys, rate limits), devboard
- `missions/` — declarative mission packages (e.g. `missions/daily-forecast/`)
- `site/` — public site
- `ops/` — systemd units/timers, deploy docs, prepped-not-deployed configs

## Critical discipline (non-negotiable)

**Server code must be mission-generic.** `grep forecast` (or any other mission-specific term) in `server/src` must return nothing — mission logic lives only inside its own `missions/<id>/` package. This is checked in CI as a hard gate; don't reintroduce mission-specific strings into server code.

Other standing rules:
- `.gitattributes` forces LF repo-wide — a CRLF shebang from Windows breaks `npx` on mac/linux.
- `npm test` at root; discipline grep is part of the gate.
- Never commit `BUILD_BRIEF.md`, `DEV_LAUNCH_BRIEF.md`, or `LAUNCH_POSTS.md`.
- GitHub deploy keys are disabled on the org repo — box updates ship via `git archive <branch> | ssh tar -x`, not a pull-based deploy.

## Infra

The live network runs on a shared production box. All coordinates, access recipes, nginx/systemd patterns, and the deploy one-liner live in `docs/OPERATIONS.md` — untracked and private; ask the owner if you need it. Never SSH or deploy without a fresh explicit go from Lawrence in the current conversation.
