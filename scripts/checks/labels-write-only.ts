import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// Pipeline labels are a write-only mirror: no app decision reads one. Three syntactic pins keep it so.
// Regex-based, dependency-free, reading directories by explicit path.
export default async function ({ expect, fail, ok }: Reporter) {
  const check = 'labels-write-only';
  const mainDir = 'apps/desktop/src/main';
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const sources = walk(join(root, mainDir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => relOf(f));

  // --- Vacuity guard: the directories the rules scan exist and hold sources. ---
  for (const dir of ['github', 'tick', 'dispatch', 'operator', 'state', 'stage', 'pipeline-state']) {
    expect(sources.some((f) => f.startsWith(`${mainDir}/${dir}/`)), check, `${mainDir}/${dir}/ holds no sources — the label-read rules cannot pass vacuously`);
  }

  // --- (a) The files that parse label names off a GitHub node are enumerated, each with the reason it is not a decision. ---
  {
    const SOURCES: Record<string, string> = {
      [`${mainDir}/github/map.ts`]: "the sweep's candidate index and the seed source; for a seeded repository pipeline.ts replaces its keys with the store's",
      [`${mainDir}/github/adapter.ts`]: "the fresh read; it feeds the mirror diff's observed set and the assignee precondition",
      [`${mainDir}/github/backlog.ts`]: 'Backlog chips (display)',
      [`${mainDir}/github/release-prs.ts`]: 'release-note chips; no pipeline label is involved',
      [`${mainDir}/github/release-issues.ts`]: 'release-note chips and dependency grouping; no pipeline label is involved',
    };
    const parsesLabels = /\b(?:fieldListOf|labelsOf)\(\s*[\w.]+\.labels\b/;
    const parsing = sources.filter((f) => parsesLabels.test(read(f)));
    for (const f of parsing) {
      expect(f in SOURCES, check, `${f} parses GitHub labels and is not a sanctioned source. Pipeline labels are a write-only mirror: read the stage from the store (stateLabels), or add the file to SOURCES with the reason it is not a decision.`);
    }
    for (const f of Object.keys(SOURCES)) {
      expect(parsing.includes(f), check, `${f} is listed as a label source (${SOURCES[f]}) but no longer parses labels — remove it from SOURCES`);
    }
  }

  // --- (b) No decision module reads an item's GitHub labels; the store is the only source. ---
  {
    const decisionDirs = ['tick', 'dispatch', 'operator', 'state', 'stage'].map((d) => `${mainDir}/${d}/`);
    const decision = sources.filter((f) => f === `${mainDir}/claim.ts` || decisionDirs.some((d) => f.startsWith(d)));
    const readShape = /\b(?:resolved\w*|fresh|reread|item|fetch\.item)\.labels\b/;
    for (const f of decision) {
      for (const line of read(f).split('\n')) {
        expect(!readShape.test(line), check, `${f} reads an item's GitHub labels (${line.trim()}) — read the stage from the store (stateLabels)`);
      }
    }
  }

  // --- (c) Workflows: only the merge gate reads a pull request's labels for a verdict. ---
  {
    const files = ['.github/workflows', 'plugins/port/templates']
      .filter((dir) => existsSync(join(root, dir)))
      .flatMap((dir) => walk(join(root, dir)).filter((f) => f.endsWith('.yml')).map((f) => relOf(f)));
    expect(files.some((f) => f.endsWith('/approval-check.yml')), check, 'no approval-check.yml was found — the workflow rule cannot pass vacuously');
    const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
    let found = false;
    for (const f of files) {
      const name = nameOf(f);
      for (const line of read(f).split('\n')) {
        if (line.trimStart().startsWith('#')) continue;
        if (name !== 'approval-check.yml' && /--json\s+labels\b|\.labels\[\]/.test(line)) {
          found = true;
          fail(check, `${f} reads a pull request's label set (${line.trim()}) — only approval-check.yml, the merge gate, may`);
        }
        // artifacts.yml's `if:` is a trigger filter: it decides when validation runs, never a verdict.
        if (name !== 'approval-check.yml' && name !== 'artifacts.yml' && /github\.event\.pull_request\.labels/.test(line)) {
          found = true;
          fail(check, `${f} names github.event.pull_request.labels (${line.trim()}) — only approval-check.yml, the merge gate, may decide from a label; artifacts.yml may use it as a trigger filter`);
        }
      }
    }
    if (!found) ok();
  }
}
