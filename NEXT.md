# NEXT

The project's working memory. `/next` reads it first and updates it last, every run. Keep it short: move finished items to Done and prune Done to the last 10.

## Now

## Next

## Monitor
- Watch-only merge gate (`autopilot-gate.yml`): it comments on `claude/autopilot-*` PRs and never merges. Merging rules are unchanged. Leave its workflow, script and `REVIEW.md` alone.
- package.json `overrides` (minimatch ^11, glob ^14) are only for the dev toolchain (c8, eslint). Drop them once c8/test-exclude ship fixed ranges: `npm view test-exclude dependencies`
- CI on master: `gh run list --branch master --workflow ci.yml -L 3`
- Open PRs and their checks: `gh pr list` then `gh pr checks <n>`
- New issues: `gh issue list --search "created:>YYYY-MM-DD"` (security-audit.yml opens "Security Vulnerability Found in Dependencies" issues)
- Prod deps clean: `npm audit --omit=dev` (0 vulns on 2026-11-02); full `npm audit` 0 since the overrides on 2026-11-03
- Dependabot update jobs: `gh run list --workflow "Dependabot Updates" -L 5`

## Ideas

## Waiting on Oli
- Merge gate trial: after about 5 agent PRs plus one deliberately bad test change, Oli decides whether the gate may merge low-risk PRs. It only comments until then.
- PR `claude/autopilot-cf-transactions` (Cloudflare adapter transactions, undo log, a releasing `feat`): review and merge it. Oli chose "both: MongoDB-compatible API on approved Cloudflare methods". Untested on real workerd; see the PR.

## Rules from Oli
- 2026-11-07: every PR body needs filled-in `## Testing`, `## Risk` and `## How to revert` sections. Testing shows the commands you ran and their results, not just "tests pass". Before opening a PR, re-read the whole diff as if someone else wrote it. Keep PRs small. If the gate's reviews ask for changes three times, stop, say why in Waiting on Oli and leave the PR open.
- 2026-11-07: keep Node 22, 24 and 26 compatibility. Do not drop 22.x from ci.yml.
- 2026-11-02: I may merge Dependabot PRs once every real check passes (the `auto-merge` job's "unstable status" failure is harmless). Majors get a breaking-change review first.
- All changes go through an `autopilot/*` branch and PR; never push to master directly (protection is bypassable by this token).

## Done
- 2026-11-07: built Cloudflare transactions (undo log + optional transactionSync), PR open for Oli to merge
- 2026-11-07: added the watch-only merge gate, `REVIEW.md` and the Risk and How to revert PR sections
- 2026-11-07: Oli decided CI stays on Node 22, 24 and 26 (no 22.x drop); recorded in Rules
- 2026-11-07: Oli approved Cloudflare transactions; researched constraints, planned in Next/Waiting on Oli
- 2026-11-05: cleared the 7 `no-explicit-any` lint warnings in query-debugger.ts
- 2026-11-05: CI matrix tests Node 26.x (engines says >=26.1.0)
- 2026-11-04: proposed 3 ideas (Next was empty)
- 2026-11-03: overrides for minimatch and glob clear all 14 dev-only npm audit advisories
- 2026-11-03: removed unused root scratch files `scratch.ts`, `test-projection.ts` (PROJECT.md kept: it's the maintained design doc)
- 2026-11-02: merged Dependabot #133, #131, #125 (Release ran green on semantic-release-action v8)
- 2026-11-02: reviewed #125 breaking changes (verdict in Waiting on Oli)
- 2026-11-02: created NEXT.md
