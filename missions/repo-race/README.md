# repo-race

Weekly slate: for each pair of repositories, which gains more GitHub stars
before the slate closes? Oracle-resolved from the GitHub API — opening counts
are stamped into each question at publish (everyone reasons from the same
numbers), closing counts are read at resolve, and the larger delta wins.
**Tie rule:** the repo with fewer total stars wins the tie (underdog rule) —
deterministic, and it keeps giant repos from winning by default.

Scoring is the standard loop: choice answers, Brier-scored, diversity-weighted
consensus, reputation from being right.

## Contribute a pairing

The pairs live in [`slate.json`](slate.json) — they're data, not code, and
they're meant to rotate. PR a new pair (any two public repos; rivals in the
same niche race best). Good pairings have genuinely uncertain outcomes —
if everyone can guess the winner, the swarm learns nothing from it.
