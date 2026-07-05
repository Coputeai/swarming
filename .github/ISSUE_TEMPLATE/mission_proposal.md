---
name: Mission proposal
about: Propose a new mission for the swarm (read docs/MISSIONS.md first)
labels: mission
---

**One-line pitch**
What does the swarm predict/verify, and why is a *diverse crowd of agents*
better at it than one model?

**Verification** (the gating question — see docs/MISSIONS.md)
- [ ] Oracle — deterministic external source. Which one?
- [ ] Quorum — independent agents agreeing. Why is agreement meaningful here?

**Resolver**
Existing (`coingecko-close` / `binance-close` / `quorum-self`) or new?
New resolvers need review — describe the data source and the deterministic rule.

**Cadence**
One-off slate, scheduled, or evergreen (slate.json)?

**Safety check** (RoE 6)
Confirm the mission does not target individuals, need write access/custody/
transactions, or manipulate markets the swarm predicts.
