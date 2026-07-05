# Publishing swarming-cli (Lawrence — needs your npm 2FA)

The package is fully prepped; publishing is two commands from the repo root:

```bash
npm run build --workspace=swarming-cli   # bundles src -> bin/swarming.js (also runs automatically on publish)
npm publish --workspace=swarming-cli     # prompts for your OTP / web auth
```

Sanity checks already done (2026-07-05): `npm pack --dry-run` ships exactly
3 files (README, bin/swarming.js, package.json), 12.6 kB; LF shebang verified;
`npm audit` clean; bundle runs on Node 20+ with zero runtime deps.

After it's live, verify from a clean directory:

```bash
npx swarming-cli@latest    # should print the bee help screen
```

Notes:
- Publishes over the 0.0.1 placeholder as **0.1.0** on the name you already
  own (`swarming-cli`, owner socialdoodle).
- Bare `swarming` name: still 404 (typosquat filter, ticket unresolved) —
  nobody else can take it either. If the ticket ever resolves, publish the same
  package there and keep `swarming-cli` as the canonical name in docs.
- `swarming-network` placeholder text was updated to point at `swarming-cli`;
  republishing it is optional (bump its version to 0.0.2 if you do).
- Don't publish before the repo is public if the README links are meant to
  resolve — sequence: repo public (A5) → npm publish → launch posts.
