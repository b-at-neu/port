import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// Issue-side reads live behind the `Tracker` seam: only the GitHub tracker names an issue query,
// and consumers import `main/tracker`, never the GitHub implementation.
export default async function ({ expect }: Reporter) {
  const check = 'desktop-tracker';
  const srcDir = 'apps/desktop/src';
  const trackerDir = `${srcDir}/main/github/tracker/`;
  const seamFile = `${srcDir}/main/tracker/index.ts`;

  const files = walk(join(root, srcDir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const code = (rel: string) =>
    readFileSync(join(root, rel), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');

  // Each exception carries its reason: none of them reads an issue through a tracker-shaped query.
  const EXCEPTIONS: Record<string, string> = {
    [`${srcDir}/main/writes/`]: 'gh writes, not reads',
    [`${srcDir}/main/hosting/label-guard.ts`]: 'matches agent commands and runs no query',
    [`${srcDir}/main/github/release-query.ts`]: "release notes read a merged pull request's closing references, with the release flow only GitHub has",
  };
  const excepted = (rel: string) => Object.keys(EXCEPTIONS).some((prefix) => rel.startsWith(prefix));

  const ISSUE_QUERIES = ['issueOrPullRequest(', 'issue(number:', 'issues(', 'subIssues', 'blockedBy(', 'blocking(', 'closedByPullRequestsReferences(', 'closingIssuesReferences('];
  const ISSUE_REST = /repos\/[^\s`'"]*\/issues\b/;

  // --- (a) No file outside the GitHub tracker names a GitHub issue query. ---
  for (const f of files) {
    const rel = relOf(f);
    if (rel.startsWith(trackerDir) || excepted(rel)) continue;
    const text = code(rel);
    const named = [...ISSUE_QUERIES.filter((needle) => text.includes(needle)), ...(ISSUE_REST.test(text) ? ['a /issues REST path'] : [])];
    expect(named.length === 0, check, `${rel} names a GitHub issue query (${named.join(', ')}) — issue reads belong to ${trackerDir}, behind the Tracker seam`);
  }

  // --- (b) Only the adapter, the seam and the write chokepoint import the GitHub tracker. ---
  for (const f of files) {
    const rel = relOf(f);
    if (rel.startsWith(`${srcDir}/main/github/`) || rel.startsWith(`${srcDir}/main/tracker/`) || rel === `${srcDir}/main/writes/apply.ts`) continue;
    expect(!/from '@\/main\/github\/tracker(\/|')/.test(code(rel)), check, `${rel} imports the GitHub tracker directly — import ${srcDir}/main/tracker instead`);
  }

  // --- (c) Vacuity: the tracker folder holds the issue queries and the seam exists. ---
  const trackerSources = files.map((f) => relOf(f)).filter((rel) => rel.startsWith(trackerDir));
  const trackerText = trackerSources.map((rel) => code(rel)).join('\n');
  expect(trackerText.includes('issueOrPullRequest(') && trackerText.includes('subIssues'), check, `${trackerDir} no longer holds an 'issueOrPullRequest(' and a 'subIssues' query — the scope rule cannot pass vacuously`);
  expect(existsSync(join(root, seamFile)), check, `${seamFile} is missing — consumers have no seam to import`);
}
