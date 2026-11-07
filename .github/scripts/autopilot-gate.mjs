// Watch-only verdict for agent PRs. Reads the PR, its checks and the two Claude
// reviews, then posts one comment saying whether the PR would have merged.
// It has no merge code. Anything unclear counts as "would block".
import { pathToFileURL } from 'node:url';

export const ROUND_LIMIT = 3;
export const LINE_LIMIT = 500;
const MARKER = '<!-- autopilot-gate';
const SAFE_TITLE = /^(chore|docs|style|test|build|ci)(\([^)]+\))?: \S/;
const HUMAN_PATHS = [
  /^\.github\//,
  /^\.releaserc/,
  /^package(-lock)?\.json$/,
  /^REVIEW\.md$/,
  /(^|\/)CODEOWNERS$/,
];
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export function parseReview(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || !['pass', 'block'].includes(value.verdict) || !Array.isArray(value.findings)) {
    return null;
  }
  return value;
}

function hasSection(body, name) {
  const lines = (body ?? '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`.toLowerCase());
  if (start === -1) return false;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('').trim().length > 0;
}

export function nextRound(previous, sha) {
  if (!previous) return 1;
  return previous.sha === sha ? previous.rounds : previous.rounds + 1;
}

// Returns the reasons a PR would not merge. An empty list means it would.
export function decide({ pr, eventSha, files, requiredChecks, checkRuns, security, code, round }) {
  const reasons = [];
  if (pr.head.sha !== eventSha) reasons.push('A newer commit arrived after these reviews started.');
  if (pr.state !== 'open' || pr.draft) reasons.push('The PR is closed or a draft.');
  if (!SAFE_TITLE.test(pr.title)) {
    reasons.push('The title is not a non-releasing type (chore, docs, style, test, build, ci).');
  }
  if (/BREAKING[ -]CHANGE/.test(pr.body ?? '')) reasons.push('The description mentions a breaking change.');
  for (const name of ['Testing', 'Risk', 'How to revert']) {
    if (!hasSection(pr.body, name)) reasons.push(`The "${name}" section is missing or empty.`);
  }
  if (files.length === 0) reasons.push('The list of changed files came back empty.');
  const held = files.filter((f) => HUMAN_PATHS.some((p) => p.test(f.filename)));
  if (held.length) {
    reasons.push(`These paths always need Oli: ${held.map((f) => f.filename).join(', ')}.`);
  }
  const lines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (lines > LINE_LIMIT) reasons.push(`It changes ${lines} lines, over the ${LINE_LIMIT} limit.`);
  if (round > ROUND_LIMIT) reasons.push(`This is review round ${round}, over the limit of ${ROUND_LIMIT}.`);

  const byName = new Map(checkRuns.map((run) => [run.name, run]));
  if (requiredChecks.length === 0) reasons.push('No required checks could be read for master.');
  for (const name of requiredChecks) {
    if (!byName.has(name)) reasons.push(`Required check "${name}" has not reported.`);
  }
  for (const run of checkRuns) {
    if (run.status !== 'completed') reasons.push(`Check "${run.name}" has not finished.`);
    else if (!OK_CONCLUSIONS.has(run.conclusion)) reasons.push(`Check "${run.name}" ended as ${run.conclusion}.`);
  }

  if (!security) reasons.push('The security review gave no usable result.');
  else if (security.verdict !== 'pass' || security.findings.length) reasons.push('The security review raised a finding.');
  if (!code) reasons.push('The code review gave no usable result.');
  else {
    if (code.verdict !== 'pass' || code.findings.some((f) => f.severity === 'important')) {
      reasons.push('The code review raised an important finding.');
    }
    if (code.behaviour_change !== false && files.some((f) => f.filename.startsWith('src/'))) {
      reasons.push('It changes src/ and the code review did not rule out a behaviour change.');
    }
  }
  return reasons;
}

// Review text is model output on a public PR: no mentions, no hidden markers.
export function clean(text) {
  return String(text ?? '')
    .replace(/<!--|-->/g, '')
    .replace(/@/g, '@​')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function reviewLines(title, review) {
  if (!review) return [`**${title}:** no usable result.`];
  const lines = [`**${title}:** ${review.verdict}. ${clean(review.summary)}`];
  for (const f of review.findings) {
    lines.push(`- ${clean(f.severity)} \`${clean(f.file)}:${clean(f.line)}\`: ${clean(f.summary)}`);
  }
  return lines;
}

export function renderComment({ sha, round, reasons, security, code }) {
  const headline = reasons.length
    ? '**Autopilot gate (watch only): would block.** Oli merges either way during this trial.'
    : '**Autopilot gate (watch only): would merge.** Oli merges either way during this trial.';
  return [
    `${MARKER} rounds=${round} sha=${sha} -->`,
    headline,
    '',
    `Commit \`${sha.slice(0, 7)}\`, review round ${round}.`,
    ...(reasons.length ? ['', '**Why:**', ...reasons.map((r) => `- ${r}`)] : []),
    '',
    ...reviewLines('Security review', security),
    '',
    ...reviewLines('Code review', code),
  ].join('\n');
}

async function main() {
  const { GITHUB_REPOSITORY: repo, GH_TOKEN: token, PR_NUMBER: number, HEAD_SHA: eventSha } = process.env;
  const dryRun = process.env.DRY_RUN === '1';
  const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status}`);
    return res.json();
  };
  const pages = async (path, pick = (x) => x) => {
    const all = [];
    for (let page = 1; page <= 30; page += 1) {
      const items = pick(await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  };

  const pr = await api(`repos/${repo}/pulls/${number}`);
  const files = await pages(`repos/${repo}/pulls/${number}/files`);
  const rules = await pages(`repos/${repo}/rules/branches/${pr.base.ref}`);
  const requiredChecks = rules
    .filter((r) => r.type === 'required_status_checks')
    .flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));

  // The gate's own jobs are named "gate: ..." and are not waited on.
  const readChecks = async () =>
    (await pages(`repos/${repo}/commits/${eventSha}/check-runs`, (x) => x.check_runs)).filter(
      (run) => !run.name.startsWith('gate: '),
    );
  const deadline = Date.now() + Number(process.env.CHECK_WAIT_MINUTES ?? 30) * 60_000;
  let checkRuns = await readChecks();
  const settled = (runs) =>
    runs.every((run) => run.status === 'completed') &&
    requiredChecks.every((name) => runs.some((run) => run.name === name));
  while (!settled(checkRuns) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    checkRuns = await readChecks();
  }

  const comments = await pages(`repos/${repo}/issues/${number}/comments`);
  const existing = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER));
  const seen = existing?.body.match(/rounds=(\d+) sha=([0-9a-f]+)/);
  const round = nextRound(seen ? { rounds: Number(seen[1]), sha: seen[2] } : null, eventSha);

  const security = parseReview(process.env.SECURITY_REVIEW);
  const code = parseReview(process.env.CODE_REVIEW);
  const reasons = decide({ pr, eventSha, files, requiredChecks, checkRuns, security, code, round });
  const body = renderComment({ sha: eventSha, round, reasons, security, code });
  if (dryRun) {
    console.log(body);
    return;
  }
  const path = existing ? `repos/${repo}/issues/comments/${existing.id}` : `repos/${repo}/issues/${number}/comments`;
  await api(path, { method: existing ? 'PATCH' : 'POST', body: JSON.stringify({ body }) });
  console.log(reasons.length ? 'would block' : 'would merge');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
