// Regression guard for #177: the operator's stated 500-line-per-file maximum
// existed nowhere — not in docs/ENGINEERING.md, not as a check — so nothing
// ever enforced it and three (later six) shipped files grew past it
// unnoticed. This enforces the limit as a shrinking ratchet: every over-limit
// file is enumerated here with its exact, current line count, and any
// deviation from that count — up *or* down — fails, so the debt list can
// only ever move toward zero and never quietly drift out of sync with the
// tree it describes.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root, readJson } from '../lib/files.mjs';
import { globToRegExp } from '../../plugins/port/hooks/lib/guard-rules.mjs';

const CONFIG_REL = 'scripts/checks/file-size.config.json';

/** Identical to `wc -l` for a newline-terminated file. Stable across
 *  platforms because `.gitattributes` forces `eol=lf`, which is what makes a
 *  recorded count reproducible from one contributor's checkout to another's. */
function countLines(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** A NUL byte in the first 8 KB is the same heuristic `git` itself uses to
 *  decide whether a file is text. */
function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

export default async function ({ fail, note, ok }) {
  const configPath = join(root, CONFIG_REL);
  if (!existsSync(configPath)) {
    note(`file-size: ${CONFIG_REL} does not exist — no file-size limit configured`);
    return;
  }

  let config;
  try {
    config = readJson(CONFIG_REL);
  } catch (e) {
    fail('file-size', `${CONFIG_REL} is not valid JSON: ${e.message}`);
    return;
  }

  const { limit, exclude = [], allowlist = [] } = config;

  if (limit === null) {
    note('file-size: limit is null — no file-size limit configured for this repository');
    return;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    fail('file-size', `${CONFIG_REL}: 'limit' must be a positive integer or null, got ${JSON.stringify(limit)}`);
    return;
  }
  if (!Array.isArray(exclude) || !Array.isArray(allowlist)) {
    fail('file-size', `${CONFIG_REL}: 'exclude' and 'allowlist' must both be arrays`);
    return;
  }
  ok();

  // Resolve the standards document this ticket's own limit must agree with —
  // read-only, and only to know which file to cite and later pin against.
  let standardsDocRel = null;
  try {
    standardsDocRel = readJson('.claude/port.config.json').docs?.engineering ?? null;
  } catch {
    standardsDocRel = null;
  }
  const standardsDocLabel = standardsDocRel ?? 'the engineering standards document (docs.engineering not set)';

  // --- Discover tracked files --------------------------------------------
  // Fails open (a note, not a failure) when git is unavailable — the ratchet
  // still runs over the allowlist itself, which names its paths explicitly
  // and needs no discovery. Only "a new file crossed the limit" goes unseen.
  let trackedFiles = null;
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    trackedFiles = out.split('\0').filter(Boolean);
  } catch (e) {
    note(`file-size: 'git ls-files' unavailable (${e.message}) — checking only the allowlisted paths`);
  }
  const trackedSet = trackedFiles ? new Set(trackedFiles) : null;

  // --- Validate the config's shape against the tree, both directions -----
  const excludeRes = [];
  for (const entry of exclude) {
    if (!entry || typeof entry.glob !== 'string' || entry.glob.length === 0) {
      fail('file-size', `${CONFIG_REL}: an exclude entry is missing a 'glob' string`);
      continue;
    }
    if (typeof entry.why !== 'string' || entry.why.trim().length === 0) {
      fail('file-size', `exclude entry \`${entry.glob}\` has no 'why' — every exclusion states its reason`);
    }
    const re = globToRegExp(entry.glob);
    if (trackedSet && ![...trackedSet].some((f) => re.test(f))) {
      fail('file-size', `exclude glob \`${entry.glob}\` matches no tracked file — remove it or fix the glob`);
    }
    excludeRes.push({ ...entry, re });
  }

  for (const entry of allowlist) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      fail('file-size', `${CONFIG_REL}: an allowlist entry is missing a 'path' string`);
      continue;
    }
    if (!Number.isInteger(entry.lines) || entry.lines <= limit) {
      fail(
        'file-size',
        `allowlist entry \`${entry.path}\` records ${JSON.stringify(entry.lines)} lines, at or under the ${limit}-line limit`,
      );
    }
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      fail('file-size', `allowlist entry \`${entry.path}\` names no follow-up issue`);
    }
    if (trackedSet && !trackedSet.has(entry.path)) {
      fail('file-size', `allowlist entry \`${entry.path}\` is not a tracked file — remove it`);
    }
  }
  ok();

  // --- Apply the ratchet ---------------------------------------------------
  const allowMap = new Map(allowlist.filter((e) => e && typeof e.path === 'string').map((e) => [e.path, e]));
  let measured = 0;
  let excludedCount = 0;
  let skippedCount = 0;
  let largest = null;

  function checkFile(relPath) {
    const abs = join(root, relPath);
    if (!existsSync(abs)) {
      skippedCount++;
      return;
    }
    if (excludeRes.some((e) => e.re.test(relPath))) {
      excludedCount++;
      return;
    }
    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      skippedCount++;
      return;
    }
    const lines = countLines(buf.toString('utf8'));
    measured++;
    if (!largest || lines > largest.lines) largest = { path: relPath, lines };

    const allow = allowMap.get(relPath);
    if (lines > limit) {
      if (!allow) {
        fail(
          'file-size',
          `\`${relPath}\` is ${lines} lines, over the ${limit}-line limit — split it by topic (${standardsDocLabel} §7) or record it in ${CONFIG_REL}`,
        );
      } else if (lines > allow.lines) {
        fail(
          'file-size',
          `\`${relPath}\` is ${lines} lines, above its recorded ${allow.lines} — the allowlist is a ratchet: a listed file may shrink, never grow`,
        );
      } else if (lines < allow.lines) {
        fail(
          'file-size',
          `\`${relPath}\` is ${lines} lines, below its recorded ${allow.lines} — lower its entry to ${lines} so the ratchet tightens`,
        );
      } else {
        ok();
      }
    } else if (allow) {
      fail('file-size', `\`${relPath}\` is ${lines} lines, at or under the limit — remove its allowlist entry`);
    } else {
      ok();
    }
  }

  if (trackedFiles) {
    for (const f of trackedFiles) checkFile(f);
  } else {
    for (const entry of allowlist) {
      if (entry && typeof entry.path === 'string') checkFile(entry.path);
    }
  }

  note(
    `file-size: ${measured} files measured, ${excludedCount} excluded, ${skippedCount} skipped (absent or binary), ` +
      `${allowlist.length} allowlisted` +
      (largest ? `, largest is \`${largest.path}\` at ${largest.lines} lines` : ''),
  );

  // --- The stated limit must agree with the configured one ----------------
  if (!standardsDocRel) {
    note('file-size: docs.engineering is not set — skipping the limit pin against it');
    return;
  }
  const standardsDocPath = join(root, standardsDocRel);
  if (!existsSync(standardsDocPath)) {
    note(`file-size: ${standardsDocRel} does not exist — skipping the limit pin`);
    return;
  }
  const standardsText = readFileSync(standardsDocPath, 'utf8');
  const matches = [...standardsText.matchAll(/a source file is at most (\d+) lines/gi)];
  if (matches.length === 0) {
    fail('file-size', `${standardsDocRel} states no limit while ${CONFIG_REL} sets ${limit} — the two must agree`);
  } else if (matches.length > 1) {
    fail('file-size', `${standardsDocRel} states the line limit more than once — it must appear exactly once, citably`);
  } else if (Number(matches[0][1]) !== limit) {
    fail(
      'file-size',
      `${standardsDocRel} states ${matches[0][1]} while ${CONFIG_REL} sets ${limit} — the two must agree`,
    );
  } else {
    ok();
  }
}
