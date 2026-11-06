# NEXT

The project's working memory. `/next` reads it first and updates it last, every run. Keep it short: move finished items to Done and prune Done to the last 10.

## Now

## Next

## Monitor
- package.json `overrides` (minimatch ^11, glob ^14) are only for the dev toolchain (c8, eslint). Drop them once c8/test-exclude ship fixed ranges: `npm view test-exclude dependencies`
- CI on master: `gh run list --branch master --workflow ci.yml -L 3`
- Open PRs and their checks: `gh pr list` then `gh pr checks <n>`
- New issues: `gh issue list --search "created:>YYYY-MM-DD"` (security-audit.yml opens "Security Vulnerability Found in Dependencies" issues)
- Prod deps clean: `npm audit --omit=dev` (0 vulns on 2026-11-02); full `npm audit` 0 since the overrides on 2026-11-03
- Dependabot update jobs: `gh run list --workflow "Dependabot Updates" -L 5`

## Ideas
- Cloudflare adapter transactions: it throws "Transactions are not supported yet" (docs/COMPATIBILITY.md). D1 batch() might give atomic writes for `withTransaction`. Larger, needs Oli's go-ahead.

## Waiting on Oli
- CI now tests Node 26 too. To finish matching `engines`: in the "Protect Master" ruleset, make `build-and-test (26.x)` a required check instead of `build-and-test (22.x)`, then I'll drop 22.x from ci.yml. Repo settings > Rules > Rulesets.

## Rules from Oli
- 2026-11-02: I may merge Dependabot PRs once every real check passes (the `auto-merge` job's "unstable status" failure is harmless). Majors get a breaking-change review first.
- All changes go through an `autopilot/*` branch and PR; never push to master directly (protection is bypassable by this token).

## Done
- 2026-11-05: cleared the 7 `no-explicit-any` lint warnings in query-debugger.ts
- 2026-11-05: CI matrix tests Node 26.x (engines says >=26.1.0)
- 2026-11-04: proposed 3 ideas (Next was empty)
- 2026-11-03: overrides for minimatch and glob clear all 14 dev-only npm audit advisories
- 2026-11-03: removed unused root scratch files `scratch.ts`, `test-projection.ts` (PROJECT.md kept: it's the maintained design doc)
- 2026-11-02: merged Dependabot #133, #131, #125 (Release ran green on semantic-release-action v8)
- 2026-11-02: reviewed #125 breaking changes (verdict in Waiting on Oli)
- 2026-11-02: created NEXT.md
