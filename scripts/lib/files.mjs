// Shared file-system helpers every scripts/checks/*.mjs module needs:
// resolving the repository root from this file's own location, reading and
// parsing JSON, walking a directory tree, extracting frontmatter, and
// normalizing a path relative to root for failure messages.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

export const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

/** `f` relative to `root`, with `\` normalized to `/` so a failure message
 *  names the same path on Windows as on macOS/Linux. */
export const relOf = (f) => f.slice(root.length + 1).split('\\').join('/');

/** `SKILL.md` plus `TICK-PROSE.md`, concatenated — #203 moved the tick
 *  procedure, refresh sweep, contention gate, zero-diff gate, liveness
 *  cross-check, cycle cap, and pacing prose into the latter, followed only
 *  when `commands.tick` is null. A phrase check that used to grep `SKILL.md`
 *  alone for one of those sections now reads both, so it keeps meaning what
 *  it did before the move rather than passing vacuously against a file that
 *  no longer holds the phrase. */
export const pipelineTickText = () =>
  `${readFileSync(join(root, 'plugins/port/skills/pipeline/SKILL.md'), 'utf8')}\n${readFileSync(join(root, 'plugins/port/skills/pipeline/TICK-PROSE.md'), 'utf8')}`;

/** Frontmatter key/value pairs. Deliberately not a YAML parser — presence and
 *  scalar shape is all these checks need, and a dependency is not worth it. */
export function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}
