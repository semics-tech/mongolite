# NEXT

The project's working memory. `/next` reads it first and updates it last, every run. Keep it short: move finished items to Done and prune Done to the last 10.

## Now

## Next
- Remove stray root files `scratch.ts`, `test-projection.ts` and the stale `PROJECT.md` (an old mongolite-ts package.json) once confirmed unused.

## Monitor
- CI on master: `gh run list --branch master --workflow ci.yml -L 3`
- Open PRs and their checks: `gh pr list` then `gh pr checks <n>`
- New issues: `gh issue list --search "created:>YYYY-MM-DD"` (security-audit.yml opens "Security Vulnerability Found in Dependencies" issues)
- Prod deps clean: `npm audit --omit=dev` (0 vulns on 2026-11-02)
- Dependabot update jobs: `gh run list --workflow "Dependabot Updates" -L 5`

## Ideas
- minimatch advisory GHSA-g3hv-75wg-m249 (moderate) is dev-only, via c8 > test-exclude > glob. Dependabot's security update fails (needs minimatch >= 11.0.1, the tree caps at 10.2.6). A package.json `overrides` entry for minimatch would close it if c8 still passes; check before adding.

## Waiting on Oli
- #125 (semantic-release-action 6 to 8) reviewed: safe to merge. Breaking changes are the removed `branch` input and a semantic-release >= 20 floor; release.yml uses neither (branches live in .releaserc.json, semantic_version unpinned). Extra plugins changelog@6 and git@10 still fit. If the first release run after merge fails, revert. https://github.com/semics-tech/mongolite/pull/125
- Dependabot PRs #133 (@types/node patch) and #131 (claude-code-action) are green. Self mode lets me merge only my own PRs: OK to merge green patch/minor Dependabot PRs too?

## Done
- 2026-11-02: reviewed #125 breaking changes (verdict in Waiting on Oli)
- 2026-11-02: created NEXT.md
