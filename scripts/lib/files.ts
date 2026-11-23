// Shared file-system helpers every scripts/checks/*.ts module needs: repository root,
// JSON, directory walking, frontmatter, and path normalization for failure messages.
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

/** Every `.md` file directly under `dir`, sorted by filename and joined with `\n`. Fails
 *  open on location, closed on absence: a pinned phrase may live in any companion of the hub. */
const companionText = (dir: string): string =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => readFileSync(join(root, dir, f), 'utf8'))
    .join('\n');

/** `SKILL.md` plus every sibling `.md` under `plugins/port/skills/pipeline/`. A phrase check
 *  that used to grep `SKILL.md` alone now reads the whole union, so a move never passes it vacuously. */
export const pipelineSkillText = () => companionText('plugins/port/skills/pipeline');

/** `PIPELINE.md` plus every sibling `.md` under `plugins/port/docs/`. Same trade as `pipelineSkillText` above. */
export const pipelineDocsText = () => companionText('plugins/port/docs');

/** Frontmatter key/value pairs from already-read text. Deliberately not a YAML parser —
 *  presence and scalar shape is all these checks need. Split out so a self-test can exercise it directly. */
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

/** The named `##`-level markdown section's body, up to the next `##` heading or end of file.
 *  `(?![\s\S])` is the true end-of-string test — a bare `$` with the `m` flag matches end-of-line too. */
export function sectionText(text: string, heading: string): string {
  const re = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm');
  return re.exec(text)?.[1] ?? '';
}

/** Extracts a YAML block-scalar value (`<key>: |`): every indented line after it, dedented by
 *  the minimum indentation. Normalizes `\r\n` first. `null` when `key: |` is absent. */
export function blockScalar(text: string, key: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const startRe = new RegExp(`^${key}:\\s*\\|`);
  const startIdx = lines.findIndex((l) => startRe.test(l));
  if (startIdx === -1) return null;

  const collected: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    if (/^[ \t]/.test(line)) {
      collected.push(line);
      continue;
    }
    break;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();

  const indents = collected.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return collected.map((l) => (l === '' ? '' : l.slice(indent))).join('\n');
}
