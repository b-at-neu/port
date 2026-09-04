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
