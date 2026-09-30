// Shared file-system helpers every scripts/checks/*.ts module needs:
// resolving the repository root from this file's own location, reading and
// parsing JSON, walking a directory tree, extracting frontmatter, and
// normalizing a path relative to root for failure messages.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const readJson = (rel: string): any => JSON.parse(readFileSync(join(root, rel), 'utf8'));

export const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

/** `f` relative to `root`, with `\` normalized to `/` so a failure message
 *  names the same path on Windows as on macOS/Linux. */
export const relOf = (f: string): string => f.slice(root.length + 1).split('\\').join('/');

/** Every `.md` file directly under `dir`, sorted by filename and joined with
 *  `\n`. A union **fails open on location and closed on absence**: a pinned
 *  phrase may live in any companion of the hub, so moving it between them
 *  never breaks a check, while deleting it still fails. Right trade for a
 *  phrase-presence pin ("the shipped docs still say X"); wrong one for a
 *  structural pin (a heading slice, a table parse), which is why a check
 *  reading one of those still names its file directly instead of calling
 *  this. Directory-derived, never a hard-coded file list, so the next split
 *  of either hub costs no check churn (#181). */
const companionText = (dir: string): string =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => readFileSync(join(root, dir, f), 'utf8'))
    .join('\n');

/** `SKILL.md` plus every sibling `.md` under `plugins/port/skills/pipeline/`
 *  — `TICK-PROSE.md` (#203 moved the tick procedure, refresh sweep,
 *  contention gate, zero-diff gate, liveness cross-check, cycle cap, and
 *  pacing prose there, followed only when `commands.tick` is null) and
 *  `PREFLIGHT.md` (#181 moved the startup preflight and its UX states
 *  there). Sorted order keeps `PREFLIGHT.md` < `SKILL.md` < `TICK-PROSE.md`.
 *  A phrase check that used to grep `SKILL.md` alone now reads the whole
 *  union, so it keeps meaning what it did before a move rather than passing
 *  vacuously against a file that no longer holds the phrase. */
export const pipelineSkillText = () => companionText('plugins/port/skills/pipeline');

/** `PIPELINE.md` plus every sibling `.md` under `plugins/port/docs/` —
 *  `FORMATS.md` and `RECOVERY.md` (#181 moved Output formats and the
 *  Escalation/Stopping/Recovery-runbook material there). Same trade as
 *  `pipelineSkillText` above. */
export const pipelineDocsText = () => companionText('plugins/port/docs');

/** Frontmatter key/value pairs from already-read text. Deliberately not a
 *  YAML parser — presence and scalar shape is all these checks need, and a
 *  dependency is not worth it. Split out from `frontmatter()` so a
 *  self-test can exercise this parsing logic directly against literal
 *  strings, rather than a hand-rolled duplicate that can silently drift
 *  from the real thing. */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** Frontmatter key/value pairs, read from `file` on disk. */
export function frontmatter(file: string): Record<string, string> | null {
  return parseFrontmatter(readFileSync(file, 'utf8'));
}
