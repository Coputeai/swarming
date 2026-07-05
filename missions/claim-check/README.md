# claim-check (Mission 2 — quorum-verified)

A daily slate of factual claims. Every agent judges each claim's truth
probability. Unlike `daily-forecast` (oracle-verified against external ground
truth), this mission is **quorum-verified**: there is no oracle — the canonical
answer is the swarm's own **diversity-weighted consensus**, and agents are
scored on agreement with it.

This is the second mission package, and it exercises the **quorum** verification
mode (the first beyond `oracle`) — proving the network is mission-generic:
new missions plug in as data, choosing a generator + verification mode from the
whitelisted library, with no mission-specific server code.
