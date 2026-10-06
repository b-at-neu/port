import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const TICK_DIR = 'scripts/port-tick';

async function importEngine(rel: string): Promise<any> {
  return import(pathToFileURL(join(root, rel)).href);
}

// The label-state reconciliation contract.
export default async function ({ expect, fail, ok }: Reporter) {
  // --- allOpenPRs is unconditional and carries the duplicate sweep's fields.
  // pin: `scripts/port-tick/reconcile.ts`'s `REFRESH_PAIR` ↔ `plugins/port/bin/artifacts.mjs`'s exported `PR_REFRESH_KEYS`
  const queryText = readFileSync(join(root, TICK_DIR, 'query.ts'), 'utf8');
  const buildQuerySrc = queryText.slice(queryText.indexOf('export function buildQuery'), queryText.indexOf('): string {'));
  expect(!/\bmodules\b/.test(buildQuerySrc), 'tick-reconcile', `${TICK_DIR}/query.ts still names a 'modules' parameter on buildQuery — allOpenPRs must be unconditional (#220)`);
  const allOpenPrMatch = /allOpenPRs:\s*pullRequests\(states:\s*OPEN,\s*first:\s*100\)\s*\{([^]*?)\}\s*\}\s*\}/.exec(queryText);
  if (!allOpenPrMatch) {
    fail('tick-reconcile', `${TICK_DIR}/query.ts's allOpenPRs alias no longer matches the expected shape`);
  } else {
    for (const field of ['totalCount', 'body', 'headRefName', 'baseRefName']) {
      expect(allOpenPrMatch[1].includes(field), 'tick-reconcile', `${TICK_DIR}/query.ts's allOpenPRs alias is missing '${field}' — the duplicate-pull-request sweep needs it`);
    }
  }
  expect(!/if\s*\(\s*modules\.approvalGate\s*\)\s*\{\s*parts\.push\(\s*['"`]allOpenPRs/.test(queryText), 'tick-reconcile', `${TICK_DIR}/query.ts still gates the allOpenPRs alias behind modules.approvalGate — it must be unconditional (#220)`);

  const { REFRESH_PAIR } = await importEngine(`${TICK_DIR}/reconcile.ts`);
  const artifactsText = readFileSync(join(root, 'plugins/port/bin/artifacts.mjs'), 'utf8');
  const m = /PR_REFRESH_KEYS\s*=\s*\[([^\]]*)\]/.exec(artifactsText);
  const artifactsPair = m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
  const sameSet = REFRESH_PAIR.length === artifactsPair.length && REFRESH_PAIR.every((k: string) => artifactsPair.includes(k));
  expect(sameSet, 'tick-reconcile', `reconcile.ts's REFRESH_PAIR is [${REFRESH_PAIR.join(', ')}], artifacts.mjs's PR_REFRESH_KEYS is [${artifactsPair.join(', ')}] — the two must agree, both directions`);
}
