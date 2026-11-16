import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// The desktop app moves every pipeline label itself: a bundled stage agent writes none, and the
// hand-back tokens its prompt names are exactly the ones the transition table acts on.
export default async function ({ expect, fail }: Reporter) {
  const stages = ['plan', 'impl', 'review', 'revise'] as const;
  const agentRel = (stage: string) => `apps/desktop/stage-prompts/agents/${stage}-agent.md`;
  const transitionsRel = 'apps/desktop/src/main/dispatch/transitions.ts';
  const guardRel = 'apps/desktop/src/main/hosting/label-guard.ts';

  // --- (a) No bundled agent writes, or tells anyone to write, a label. ---
  const forbidden = ['--add-label', '--remove-label', 'label-cas', '<labels.', '--label', 'gh issue edit'];
  for (const stage of stages) {
    const text = readFileSync(join(root, agentRel(stage)), 'utf8');
    for (const needle of forbidden) {
      expect(!text.includes(needle), 'desktop-stage-labels', `${agentRel(stage)} contains '${needle}' — port moves the label, the agent only hands back`);
    }
  }

  // --- (b) Every HANDBACK: token a bundled agent names is in the table for its stage, and every table token is named. ---
  const tableText = readFileSync(join(root, transitionsRel), 'utf8');
  const tableBody = /HANDBACK_TOKENS[^=]*=\s*\{([^}]*)\}/.exec(tableText);
  if (!tableBody) {
    fail('desktop-stage-labels', `${transitionsRel} has no 'HANDBACK_TOKENS = { … }' table to compare the bundled agents against`);
  } else {
    const table: Record<string, string[]> = {};
    for (const entry of tableBody[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
      table[entry[1]] = [...entry[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    }
    // A revise agent runs in two modes, so its prompt carries both vocabularies.
    const allowed: Record<string, string[]> = {
      plan: table.plan ?? [],
      impl: table.impl ?? [],
      review: table.review ?? [],
      revise: [...new Set([...(table.revise ?? []), ...(table.refresh ?? [])])],
    };
    for (const stage of stages) {
      const text = readFileSync(join(root, agentRel(stage)), 'utf8');
      const named = new Set([...text.matchAll(/HANDBACK:\s+([a-z][a-z-]*)/g)].map((m) => m[1]));
      expect(allowed[stage].length > 0, 'desktop-stage-labels', `${transitionsRel} has no HANDBACK_TOKENS entry for '${stage}'`);
      for (const token of named) {
        expect(allowed[stage].includes(token), 'desktop-stage-labels', `${agentRel(stage)} names 'HANDBACK: ${token}', which is not in HANDBACK_TOKENS for ${stage}`);
      }
      for (const token of allowed[stage]) {
        expect(named.has(token), 'desktop-stage-labels', `${agentRel(stage)} never names 'HANDBACK: ${token}', which HANDBACK_TOKENS accepts for ${stage}`);
      }
    }
  }

  // --- (c) The label guard denies every label-writing form and none of the reads. ---
  const { labelWriteOf } = await import(pathToFileURL(join(root, guardRel)).href);
  const writes = [
    'gh issue edit 52 --repo o/a --add-label planning',
    'gh pr edit 8 --repo o/a --remove-label reviewing',
    'gh pr create --repo o/a --title t --label claude',
    'gh pr create --repo o/a --title t -l claude',
    'gh api repos/o/a/issues/52/labels -f "labels[]=x"',
  ];
  const reads = ['gh pr view 8 --repo o/a --json labels', 'gh issue view 52 --repo o/a --json labels,title', 'gh pr create --repo o/a --title t --assignee op', 'gh issue comment 52 --body-file .temp/b.md'];
  for (const command of writes) expect(labelWriteOf(command) !== null, 'desktop-stage-labels', `${guardRel} lets '${command}' through`);
  for (const command of reads) expect(labelWriteOf(command) === null, 'desktop-stage-labels', `${guardRel} denies '${command}', which writes no label`);

  // --- (d) The same guard denies an issue-body write in every form, and lets comments, views and a pull request description through. ---
  const { issueBodyWriteOf } = await import(pathToFileURL(join(root, guardRel)).href);
  const bodyWrites = [
    'gh issue edit 52 --repo o/a --body-file .temp/plan-52.md',
    'gh issue edit 52 -b x',
    'gh api repos/o/a/issues/52 -X PATCH -F body=@.temp/p.md',
    'gh api repos/o/a/issues/52 --input .temp/p.json',
  ];
  const bodyReads = [
    'gh issue comment 52 --body-file .temp/b.md',
    'gh pr edit 8 --body-file .temp/pr-body-8.md',
    'gh api repos/o/a/issues/52',
    'gh api repos/o/a/issues/52/comments -f body=x',
    'gh issue view 52 --json body',
  ];
  for (const command of bodyWrites) expect(issueBodyWriteOf(command), 'desktop-stage-labels', `${guardRel} lets '${command}' through`);
  for (const command of bodyReads) expect(!issueBodyWriteOf(command), 'desktop-stage-labels', `${guardRel} denies '${command}', which writes no issue body`);
}
