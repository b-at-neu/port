import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// Pipeline labels are a write-only mirror: no app decision reads one. Four syntactic pins keep it so.
// Regex-based, dependency-free, reading directories by explicit path.
export default async function ({ expect, fail, ok }: Reporter) {
  const check = 'labels-write-only';
  const mainDir = 'apps/desktop/src/main';
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const sources = walk(join(root, mainDir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => relOf(f));

  // --- Vacuity guard: the directories the rules scan exist and hold sources. ---
  for (const dir of ['github', 'tick', 'dispatch', 'actions', 'state', 'stage', 'pipeline-state']) {
    expect(sources.some((f) => f.startsWith(`${mainDir}/${dir}/`)), check, `${mainDir}/${dir}/ holds no sources — the label-read rules cannot pass vacuously`);
  }

  // --- (a) The files that parse label names off a GitHub node are enumerated, each with the reason it is not a decision. ---
  {
    const SOURCES: Record<string, string> = {
      [`${mainDir}/github/map.ts`]: "the sweep's candidate index and the seed source; under a store view the tracked path replaces its keys with the store's",
      [`${mainDir}/github/tracker/items.ts`]: "the fresh read; it feeds the mirror diff's observed set, the assignee precondition and the labels-view fallback",
      [`${mainDir}/github/tracker/gate.ts`]: "the plan gate preflight's labels-view fallback",
      [`${mainDir}/github/tracker/backlog.ts`]: 'Backlog chips (display) and the labels-view membership fallback',
      [`${mainDir}/github/tracker/backlog-children.ts`]: 'the labels-view claimed fallback',
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

  // --- (b) Store first: in a decision module, every label read is the fallback behind a store read. ---
  {
    const decisionDirs = ['tick', 'dispatch', 'actions', 'state', 'stage'].map((d) => `${mainDir}/${d}/`);
    const decision = sources.filter((f) => f === `${mainDir}/claim.ts` || decisionDirs.some((d) => f.startsWith(d)));
    const readShape = /\b(?:resolved\w*|fresh|reread|item|fetch\.item)\.labels\b/;
    const storeFirst = /\b(?:stateLabels|storedLabels)\b[^;]*\?\?\s*(?:resolved\w*|fresh|reread|item|fetch\.item)\.labels\b/;
    let reads = 0;
    for (const f of decision) {
      for (const line of read(f).split('\n')) {
        if (!readShape.test(line)) continue;
        reads++;
        expect(storeFirst.test(line), check, `${f} reads an item's labels directly (${line.trim()}) — read the store first and fall back with '??' (stateLabels ?? item.labels)`);
      }
    }
    expect(reads > 0, check, 'no label fallback read was found under the decision modules — the store-first rule cannot pass vacuously');
  }

  // --- (c) The fallback is reachable only under a labels view: an unseeded or terminal-held repository. ---
  {
    const constructors = new Set([`${mainDir}/pipeline-state/model.ts`, `${mainDir}/pipeline-state/default.ts`, `${mainDir}/state/watcher.ts`]);
    const labelsView = /\{\s*kind:\s*'labels'\s*\}/;
    const constructing = sources.filter((f) => labelsView.test(read(f)));
    for (const f of constructing) {
      expect(constructors.has(f), check, `${f} constructs a labels view — only an unseeded or terminal-held record (model.ts, default.ts) or a watcher with no store (watcher.ts) may fall back to labels`);
    }
    for (const f of constructors) {
      expect(constructing.includes(f), check, `${f} no longer constructs a labels view — update this rule's list of constructors`);
    }

    const labelsReader = `${mainDir}/pipeline-state/labels.ts`;
    const nulls = read(labelsReader).split('\n').filter((line) => /\breturn null\b/.test(line));
    expect(nulls.length === 1 && nulls[0]!.includes("view.kind === 'labels'"), check, `${labelsReader} must have exactly one 'return null', on a line testing view.kind === 'labels' — a store view always answers from the store`);

    expect(/view\?\.kind === 'store'\s*\?\s*pipelineFetch\.items\.filter\(/.test(read(`${mainDir}/state/reconcile.ts`)), check, `${mainDir}/state/reconcile.ts must filter pipelineFetch.items to stored items under a store view — otherwise a label-matched item leaks into the table`);
    expect(/matchedKeys:\s*ref\.keys\b/.test(read(`${mainDir}/github/map.ts`)), check, `${mainDir}/github/map.ts must set matchedKeys from the store's ref.keys on the tracked path`);
  }

  // --- (d) Workflows: only the merge gate reads a pull request's labels for a verdict. ---
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
