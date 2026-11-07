import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clean, decide, nextRound, parseReview, renderComment } from './autopilot-gate.mjs';

const pass = { verdict: 'pass', findings: [], summary: 'ok', behaviour_change: false };
const base = () => ({
  eventSha: 'abc1234',
  pr: {
    head: { sha: 'abc1234' },
    state: 'open',
    draft: false,
    title: 'docs: fix a typo',
    body: '## Testing\nRan npm test.\n\n## Risk\nLow.\n\n## How to revert\nRevert the commit.\n',
  },
  files: [{ filename: 'docs/a.md', additions: 1, deletions: 1 }],
  requiredChecks: ['build-and-test (22.x)'],
  checkRuns: [{ name: 'build-and-test (22.x)', status: 'completed', conclusion: 'success' }],
  security: pass,
  code: pass,
  round: 1,
});
const blockedBy = (change, pattern) => {
  const input = base();
  change(input);
  assert.match(decide(input).join(' '), pattern);
};

test('a clean low-risk PR would merge', () => assert.deepEqual(decide(base()), []));
test('newer commit blocks', () => blockedBy((i) => (i.pr.head.sha = 'def'), /newer commit/));
test('draft blocks', () => blockedBy((i) => (i.pr.draft = true), /draft/));
for (const title of ['feat: x', 'fix: x', 'refactor: x', 'perf: x', 'docs!: x', 'docs(a)!: x', 'nonsense']) {
  test(`title "${title}" blocks`, () => blockedBy((i) => (i.pr.title = title), /non-releasing/));
}
test('scoped safe title passes', () => {
  const input = base();
  input.pr.title = 'chore(deps): bump';
  assert.deepEqual(decide(input), []);
});
test('breaking change note blocks', () => blockedBy((i) => (i.pr.body += '\nBREAKING CHANGE: x'), /breaking/));
test('missing revert section blocks', () =>
  blockedBy((i) => (i.pr.body = '## Testing\nx\n## Risk\ny\n'), /How to revert/));
test('template-only section blocks', () =>
  blockedBy((i) => (i.pr.body = '## Testing\n<!-- fill in -->\n## Risk\ny\n## How to revert\nz\n'), /Testing/));
for (const filename of ['.github/workflows/ci.yml', '.releaserc.json', 'package.json', 'package-lock.json', 'REVIEW.md']) {
  test(`${filename} needs Oli`, () =>
    blockedBy((i) => i.files.push({ filename, additions: 1, deletions: 0 }), /always need Oli/));
}
test('no files blocks', () => blockedBy((i) => (i.files = []), /empty/));
test('large change blocks', () => blockedBy((i) => (i.files[0].additions = 501), /over the 500/));
test('fourth round blocks', () => blockedBy((i) => (i.round = 4), /round 4/));
test('third round passes', () => {
  const input = base();
  input.round = 3;
  assert.deepEqual(decide(input), []);
});
test('no required checks blocks', () => blockedBy((i) => (i.requiredChecks = []), /No required checks/));
test('missing required check blocks', () => blockedBy((i) => (i.checkRuns = []), /has not reported/));
test('unfinished check blocks', () =>
  blockedBy((i) => (i.checkRuns[0] = { name: i.requiredChecks[0], status: 'in_progress' }), /not finished/));
test('failed optional check blocks', () =>
  blockedBy((i) => i.checkRuns.push({ name: 'x', status: 'completed', conclusion: 'failure' }), /ended as failure/));
test('skipped check passes', () => {
  const input = base();
  input.checkRuns.push({ name: 'x', status: 'completed', conclusion: 'skipped' });
  assert.deepEqual(decide(input), []);
});
test('missing security review blocks', () => blockedBy((i) => (i.security = null), /security review gave no/));
test('any security finding blocks, even on a pass', () =>
  blockedBy((i) => (i.security = { ...pass, findings: [{ severity: 'low' }] }), /security review raised/));
test('missing code review blocks', () => blockedBy((i) => (i.code = null), /code review gave no/));
test('important bug blocks', () =>
  blockedBy((i) => (i.code = { ...pass, findings: [{ severity: 'important' }] }), /important finding/));
test('a nit does not block', () => {
  const input = base();
  input.code = { ...pass, findings: [{ severity: 'nit' }] };
  assert.deepEqual(decide(input), []);
});
test('src change needs behaviour ruled out', () =>
  blockedBy((i) => {
    i.files.push({ filename: 'src/a.ts', additions: 1, deletions: 0 });
    i.code = { ...pass, behaviour_change: undefined };
  }, /behaviour change/));
test('src change with no behaviour change passes', () => {
  const input = base();
  input.files.push({ filename: 'src/a.ts', additions: 1, deletions: 0 });
  assert.deepEqual(decide(input), []);
});
test('bad review JSON is no result', () => {
  for (const raw of ['', 'nope', 'null', '{}', '{"verdict":"maybe","findings":[]}', '{"verdict":"pass"}']) {
    assert.equal(parseReview(raw), null);
  }
  assert.equal(parseReview(JSON.stringify(pass)).verdict, 'pass');
});
test('rounds count new commits only', () => {
  assert.equal(nextRound(null, 'a'), 1);
  assert.equal(nextRound({ rounds: 2, sha: 'a' }, 'a'), 2);
  assert.equal(nextRound({ rounds: 2, sha: 'a' }, 'b'), 3);
});
test('review text cannot mention people or hide markers', () => {
  const text = clean('hi @someone <!-- autopilot-gate rounds=1 --> done');
  assert.ok(!text.includes('<!--'));
  assert.ok(!/@[a-z]/.test(text));
});
test('nested comment markers are removed too', () => {
  const text = clean('a <!<!---->-- b --!> c <img src=x>');
  assert.ok(!/[<>]/.test(text));
});
test('a section holding only nested comments counts as empty', () =>
  blockedBy((i) => (i.pr.body = '## Testing\n<!-- a <!-- b -->\n## Risk\ny\n## How to revert\nz\n'), /Testing/));
test('an unclosed comment hides the rest', () =>
  blockedBy((i) => (i.pr.body = '## Testing\nx\n## Risk\ny\n<!-- ## How to revert\nz\n'), /How to revert/));
test('comment says watch only and carries the round', () => {
  const body = renderComment({ sha: 'abc1234', round: 2, reasons: ['x'], security: pass, code: null });
  assert.match(body, /^<!-- autopilot-gate rounds=2 sha=abc1234 -->/);
  assert.match(body, /would block/);
  assert.match(body, /Code review:\*\* no usable result/);
});
