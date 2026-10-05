// The "Comment ratchet": a per-area ceiling on issue-citing comments and
// over-long comment blocks, which may only be lowered.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { root, readJson } from '../lib/files.ts';
import { scanComments } from '../lib/comments.ts';
import type { ScanResult } from '../lib/comments.ts';
import type { Reporter } from '../lib/report.ts';
import { message } from '../lib/errors.ts';

const CONFIG_REL = 'scripts/checks/comments.config.json';
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js']);

export interface AreaConfig {
  path: string;
  citations: number;
  longBlocks: number;
}
export interface CommentsConfig {
  areas: AreaConfig[];
  grandfathered: string[];
}
export interface FileScan {
  path: string;
  citationLines: number[];
  longBlocks: number[];
}

/** Longest-prefix match, so a nested area wins over its broader parent. */
export function areaFor(filePath: string, areas: readonly AreaConfig[]): AreaConfig | null {
  let best: AreaConfig | null = null;
  for (const a of areas) {
    if (filePath.startsWith(a.path) && (best === null || a.path.length > best.path.length)) best = a;
  }
  return best;
}

/** The first 5 of `lines`, comma-joined, with a trailing `…` when more
 *  remain — so a file with dozens of citations still prints a short line. */
function lineList(lines: readonly number[]): string {
  const shown = lines.slice(0, 5).join(', ');
  return lines.length > 5 ? `${shown}, …` : shown;
}

export interface RatchetVerdict {
  failures: string[];
  notes: string[];
}

/** Pure — no file I/O, so a fixture exercises it before the real tree does. */
export function evaluateRatchet(files: readonly FileScan[], config: CommentsConfig): RatchetVerdict {
  const failures: string[] = [];
  const notes: string[] = [];
  const grandfathered = new Set(config.grandfathered);
  const scanned = new Map(files.map((f) => [f.path, f]));

  const totals = new Map(config.areas.map((a) => [a.path, { citations: 0, longBlocks: 0 }]));

  for (const file of files) {
    if (!grandfathered.has(file.path) && (file.citationLines.length > 0 || file.longBlocks.length > 0)) {
      const parts: string[] = [];
      if (file.citationLines.length > 0) parts.push(`issue-citing comment at line(s) ${lineList(file.citationLines)}`);
      if (file.longBlocks.length > 0) parts.push(`comment block over two lines at line(s) ${lineList(file.longBlocks)}`);
      failures.push(`\`${file.path}\`: ${parts.join('; ')} — a new file must have neither (docs.engineering §7)`);
    }

    const area = areaFor(file.path, config.areas);
    if (area) {
      const t = totals.get(area.path)!;
      t.citations += file.citationLines.length;
      t.longBlocks += file.longBlocks.length;
    }
  }

  for (const a of config.areas) {
    const t = totals.get(a.path)!;
    if (t.citations > a.citations) {
      failures.push(`area \`${a.path}\`: ${t.citations} issue-citing comment lines, over its ceiling of ${a.citations} — the ratchet only goes down; remove what this change added`);
    } else if (t.citations < a.citations) {
      notes.push(`comment-ratchet: area \`${a.path}\` citations ${t.citations} under ceiling ${a.citations} — lower it in ${CONFIG_REL}`);
    }
    if (t.longBlocks > a.longBlocks) {
      failures.push(`area \`${a.path}\`: ${t.longBlocks} long comment blocks, over its ceiling of ${a.longBlocks} — the ratchet only goes down; remove what this change added`);
    } else if (t.longBlocks < a.longBlocks) {
      notes.push(`comment-ratchet: area \`${a.path}\` long blocks ${t.longBlocks} under ceiling ${a.longBlocks} — lower it in ${CONFIG_REL}`);
    }
  }

  for (const g of config.grandfathered) {
    const file = scanned.get(g);
    if (!file) {
      notes.push(`comment-ratchet: grandfathered \`${g}\` is gone — remove it`);
    } else if (file.citationLines.length === 0 && file.longBlocks.length === 0) {
      notes.push(`comment-ratchet: grandfathered \`${g}\` is clean — remove it`);
    }
  }

  return { failures, notes };
}

export default async function ({ fail, note, ok }: Reporter) {
  // --- Self-test the scanner first — a check that cannot be made to fail is
  // not a check (docs/ENGINEERING.md §7) --------------------------------------
  {
    const citations = (src: string) => scanComments(src).citationLines.length;
    const blocks = (src: string) => scanComments(src).longBlocks.length;

    const cases: { label: string; src: string; citations: number; blocks: number }[] = [
      { label: 'bare citation', src: '// see #12', citations: 1, blocks: 0 },
      { label: 'citation inside a string literal', src: "const s = '// see #12';", citations: 0, blocks: 0 },
      { label: 'citation inside a multi-line template literal', src: 'const t = `line one\n// #3\nline two`;', citations: 0, blocks: 0 },
      { label: 'backtick and quote inside a regex, real citation after', src: "const re = /[`']/;\n// #4", citations: 1, blocks: 0 },
      { label: 'prose "Issue N" form', src: '// Issue 255', citations: 1, blocks: 0 },
      { label: 'the #0 sentinel and a hex-looking token', src: '// #0\n// #1f2328', citations: 0, blocks: 0 },
      { label: 'trailing comment on a code line', src: 'x(); // #5', citations: 1, blocks: 0 },
      { label: 'two-line comment block', src: '// a\n// b', citations: 0, blocks: 0 },
      { label: 'three-line comment block', src: '// a\n// b\n// c', citations: 0, blocks: 1 },
      { label: 'one-content-line jsdoc', src: '/**\n * one\n */', citations: 0, blocks: 0 },
      { label: 'four-content-line jsdoc', src: '/**\n * one\n * two\n * three\n * four\n */', citations: 0, blocks: 1 },
    ];
    for (const c of cases) {
      const gotCitations = citations(c.src);
      const gotBlocks = blocks(c.src);
      if (gotCitations !== c.citations || gotBlocks !== c.blocks) {
        fail(
          'comments-selftest',
          `scanComments(${c.label}): expected ${c.citations} citation(s)/${c.blocks} block(s), got ${gotCitations}/${gotBlocks}`,
        );
      } else {
        ok();
      }
    }
  }

  // --- Self-test evaluateRatchet -------------------------------------------
  {
    const config: CommentsConfig = {
      areas: [{ path: 'src/', citations: 1, longBlocks: 1 }],
      grandfathered: ['src/old.ts'],
    };

    const newFileCited: FileScan = { path: 'src/new.ts', citationLines: [3], longBlocks: [] };
    if (!evaluateRatchet([newFileCited], config).failures.some((f) => f.includes('src/new.ts'))) {
      fail('comments-selftest', 'evaluateRatchet did not fail a new file citing an issue');
    } else {
      ok();
    }

    const newFileBlock: FileScan = { path: 'src/new.ts', citationLines: [], longBlocks: [5] };
    if (!evaluateRatchet([newFileBlock], config).failures.some((f) => f.includes('src/new.ts'))) {
      fail('comments-selftest', 'evaluateRatchet did not fail a new file with a long comment block');
    } else {
      ok();
    }

    const grandfatheredOverCeiling: FileScan = { path: 'src/old.ts', citationLines: [1, 2], longBlocks: [] };
    const overResult = evaluateRatchet([grandfatheredOverCeiling], config);
    if (overResult.failures.length === 0 || !overResult.failures.some((f) => f.includes('over its ceiling'))) {
      fail('comments-selftest', 'evaluateRatchet did not fail an area total pushed over its ceiling');
    } else {
      ok();
    }

    const atCeiling: FileScan = { path: 'src/old.ts', citationLines: [1], longBlocks: [] };
    const atResult = evaluateRatchet([atCeiling], config);
    if (atResult.failures.length !== 0) {
      fail('comments-selftest', 'evaluateRatchet failed a file exactly at its area ceiling');
    } else {
      ok();
    }

    const underCeiling: FileScan = { path: 'src/old.ts', citationLines: [], longBlocks: [] };
    const underResult = evaluateRatchet([underCeiling], config);
    if (underResult.failures.length !== 0 || !underResult.notes.some((n) => n.includes('under ceiling'))) {
      fail('comments-selftest', 'evaluateRatchet did not note an area total under its ceiling');
    } else {
      ok();
    }
  }

  // --- Read and validate the config's own shape ----------------------------
  const configPath = join(root, CONFIG_REL);
  if (!existsSync(configPath)) {
    fail('comments', `${CONFIG_REL} does not exist — the comment ratchet is required, not optional`);
    return;
  }
  let raw: any;
  try {
    raw = readJson(CONFIG_REL);
  } catch (e) {
    fail('comments', `${CONFIG_REL} is not valid JSON: ${message(e)}`);
    return;
  }

  const rawAreas = Array.isArray(raw.areas) ? raw.areas : [];
  const rawGrandfathered = Array.isArray(raw.grandfathered) ? raw.grandfathered : [];
  if (!Array.isArray(raw.areas) || !Array.isArray(raw.grandfathered)) {
    fail('comments', `${CONFIG_REL}: 'areas' and 'grandfathered' must both be arrays`);
  } else {
    ok();
  }

  const areas: AreaConfig[] = [];
  const seenAreaPaths = new Set<string>();
  for (const a of rawAreas) {
    if (!a || typeof a.path !== 'string' || !a.path.endsWith('/')) {
      fail('comments', `${CONFIG_REL}: an area 'path' must be a string ending '/' (got ${JSON.stringify(a?.path)})`);
      continue;
    }
    if (seenAreaPaths.has(a.path)) {
      fail('comments', `${CONFIG_REL}: area \`${a.path}\` is duplicated`);
      continue;
    }
    seenAreaPaths.add(a.path);
    let entryOk = true;
    if (!Number.isInteger(a.citations) || a.citations < 0) {
      fail('comments', `${CONFIG_REL}: area \`${a.path}\`'s 'citations' ceiling must be a non-negative integer`);
      entryOk = false;
    }
    if (!Number.isInteger(a.longBlocks) || a.longBlocks < 0) {
      fail('comments', `${CONFIG_REL}: area \`${a.path}\`'s 'longBlocks' ceiling must be a non-negative integer`);
      entryOk = false;
    }
    if (entryOk) {
      areas.push({ path: a.path, citations: a.citations, longBlocks: a.longBlocks });
      ok();
    }
  }

  const grandfathered: string[] = [];
  const seenGrandfathered = new Set<string>();
  for (const g of rawGrandfathered) {
    if (typeof g !== 'string' || g.length === 0) {
      fail('comments', `${CONFIG_REL}: a 'grandfathered' entry must be a non-empty string (got ${JSON.stringify(g)})`);
      continue;
    }
    if (seenGrandfathered.has(g)) {
      fail('comments', `${CONFIG_REL}: grandfathered entry \`${g}\` is duplicated`);
      continue;
    }
    seenGrandfathered.add(g);
    if (!areaFor(g, areas)) {
      fail('comments', `${CONFIG_REL}: grandfathered entry \`${g}\` matches no configured area`);
      continue;
    }
    grandfathered.push(g);
    ok();
  }

  // --- Discover the scanned set ---------------------------------------------
  let trackedFiles: string[] | null = null;
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    trackedFiles = out.split('\0').filter(Boolean);
  } catch (e) {
    note(`comment-ratchet: 'git ls-files' unavailable (${message(e)}) — scanning only the grandfathered paths`);
  }

  const candidatePaths = trackedFiles
    ? trackedFiles.filter((f) => SCANNED_EXTENSIONS.has(extname(f)))
    : grandfathered.filter((g) => SCANNED_EXTENSIONS.has(extname(g)));

  const files: FileScan[] = [];
  for (const relPath of candidatePaths) {
    const abs = join(root, relPath);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const scan: ScanResult = scanComments(text);
    files.push({ path: relPath, citationLines: scan.citationLines, longBlocks: scan.longBlocks });
  }

  // --- Apply the ratchet ----------------------------------------------------
  const { failures, notes } = evaluateRatchet(files, { areas, grandfathered });
  for (const f of failures) fail('comment-ratchet', f);
  for (const n of notes) note(n);
  if (failures.length === 0) ok();

  note(`comment-ratchet: ${files.length} file(s) scanned across ${areas.length} area(s), ${grandfathered.length} grandfathered`);
}
