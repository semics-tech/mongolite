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

## Rules from Oli
- 2026-11-02: I may merge Dependabot PRs once every real check passes (the `auto-merge` job's "unstable status" failure is harmless). Majors get a breaking-change review first.
- All changes go through an `autopilot/*` branch and PR; never push to master directly (protection is bypassable by this token).

## Done
- 2026-11-02: merged Dependabot #133, #131, #125 (Release ran green on semantic-release-action v8)
- 2026-11-02: reviewed #125 breaking changes (verdict in Waiting on Oli)
- 2026-11-02: created NEXT.md
