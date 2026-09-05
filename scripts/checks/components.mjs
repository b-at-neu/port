import { basename, dirname, join } from 'node:path';
import { root, walk, relOf, frontmatter } from '../lib/files.mjs';

// --- Components parse and declare what they must ---------------------------
// A skill or agent whose frontmatter is malformed is silently missing from the
// component inventory. Nothing errors; it simply is not there.
export default async function ({ fail, ok }) {
  for (const [dir, kind] of [
    ['plugins/port/agents', 'agent'],
    ['plugins/port/skills', 'skill'],
  ]) {
    const files = walk(join(root, dir)).filter((f) =>
      kind === 'agent' ? f.endsWith('.md') : basename(f) === 'SKILL.md',
    );
    if (files.length === 0) fail('components', `no ${kind}s found under ${dir}`);
    for (const f of files) {
      const rel = relOf(f);
      const fm = frontmatter(f);
      if (!fm) {
        fail('frontmatter', `${rel} has no --- delimited frontmatter`);
        continue;
      }
      for (const key of ['name', 'description']) {
        if (!fm[key]) fail('frontmatter', `${rel} is missing '${key}'`);
      }
      const expected =
        kind === 'agent' ? basename(f, '.md') : basename(dirname(f));
      if (fm.name && fm.name !== expected) {
        fail('frontmatter', `${rel} declares name '${fm.name}', expected '${expected}'`);
      }
      ok();
    }
  }
}
