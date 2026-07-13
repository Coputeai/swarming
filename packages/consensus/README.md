# swarming-consensus

The Swarming network's cross-inhibition consensus engine, as a standalone
library. Same engine code as the network (imports directly from
`@swarming/protocol`'s scoring math) — not a fork. Use it to run your own N
model calls through diversity-weighted, quorum-committing deliberation
without joining the network.

> **Not yet published to npm.** This package ships in the monorepo today
> (`private: true`); publishing under `swarming-consensus` (or a scoped
> fallback if that name isn't available) is a separate step gated on Lawrence
> checking/claiming the npm name. Until then, import it via a relative path
> or `file:` dependency from this repo.

```ts
import { deliberate } from "swarming-consensus";

const verdict = await deliberate({
  question: "Will it rain in Singapore tomorrow?",
  agents: [
    async ({ question, round, leaning }) => {
      // call your own model here — plain async function, no framework coupling
      return { answer: 0.62, confidence: 0.7, rationale: "monsoon season base rate" };
    },
    // ...as many agents as you like, any model, any source
  ],
  rounds: 3,   // default 3
  quorum: 0.6, // default is the engine's own default (0.6)
});

// verdict: { answer, confidence, committed, rounds, clusters, transcript }
// committed:false means an honest abstention — the swarm didn't reach
// quorum, not a coin-flip tie-break.
```

- `answer` is `number` (0..1, the same "p" convention as the network's binary
  questions) if every agent answered with a number, otherwise a `string`
  choice compared by exact match.
- `leaning` on rounds after the first is the previous round's
  diversity-weighted aggregate — the same signal agents on the live network
  see mid-deliberation.
- `clusters` groups near-duplicate answers the same way the network discounts
  copycats/herders (1 / cluster size each). Because `deliberate()` always
  asks exactly one question, this will always come back as one singleton
  cluster per agent — the network only clusters on slates of 2+ questions
  (see `MIN_QUESTIONS_FOR_DIVERSITY` in `@swarming/protocol`), since on a
  single question "picked the same side" isn't evidence of collusion. This
  is the same defensive behavior the network itself has, not a library
  limitation.
- `transcript` is every agent's answer across every round, in order — enough
  to render the full deliberation (this is what a `watch`-style demo of a
  library call would replay).

## Build / test

```
npm run build --workspace=swarming-consensus   # bundles src -> dist/index.js
npm run test --workspace=swarming-consensus
```
