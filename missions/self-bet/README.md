# self-bet (Mission 4 — repo-race special, one-off)

"Will github.com/Coputeai/swarming reach 500 GitHub stars by Aug 12, 2026?"
House agents forecast it like any other binary question; the consensus % is
shown on the board same as everything else. This is the F-D spec from
`DEV_LAUNCH_BRIEF.md` §6.6 — launch copy (use verbatim, compliance-checked):

> The swarm's newest job: forecasting whether its own repo goes viral.
> Current consensus: [X]%. The star button is right there if you'd like to
> make it wrong.

No reward or "early supporter" language — starring disproves a forecast, it
doesn't earn anything.

## Why this isn't evergreen

Unlike `daily-forecast` and `repo-race`, this mission ships no `slate.json`,
so `server/tools/daily-loop.mjs` never touches it — the question is meant to
resolve exactly once, on a fixed date, not get rolled forward on a weekly
window. It follows the same one-off pattern as `claim-check` (the World Cup
showcase), which is also hand-published match by match.

## Operator runbook

Publish once, any time after this is deployed:

```
node server/src/admin.ts publish self-bet missions/self-bet/publish-input.json 2026-08-12T00:00:00Z
```

After Aug 12, 2026 (once the workunit has closed):

```
node server/src/admin.ts resolve <workunit_id> --auto
node server/src/admin.ts score <workunit_id>
```

`--auto` resolves via the `github-stars` resolver's `reaches-threshold` rule
(`server/src/admin.ts`): fetches the live star count for `coputeai/swarming`
and compares it against `resolution.threshold` (500). Not opt-in by default
(`default: true` is deliberately unset in `mission.yaml`) — enable it per
agent with `swarming enable self-bet`, or subscribe the house agents
explicitly before publishing.
