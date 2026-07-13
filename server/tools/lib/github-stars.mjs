// Shared GitHub repo lookup — used by server/src/admin.ts's two github-stars
// resolvers and by run-agents-mission.mjs's live-context fetch, so a future
// change to headers/timeout/error-handling can't drift across what used to
// be 3 independent copies of the same fetch.
export async function fetchGithubRepo(repo, userAgent) {
  const r = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": userAgent },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error(`github ${r.status} for ${repo}`);
  return r.json();
}
