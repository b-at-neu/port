// The Releases screen's literals must match the release skill's, in both directions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

const EXPECTED = ['Release v<version>', 'bump/v<version>', 'bump version to v<version>', '- Minor enhancements and bug fixes'];

export default async function ({ fail, ok }: Reporter) {
  const format = readFileSync(join(root, 'apps/desktop/src/utils/release/format.ts'), 'utf8');
  const skill = readFileSync(join(root, 'plugins/port/skills/release/SKILL.md'), 'utf8');

  const block = /RELEASE_LITERALS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(format)?.[1] ?? '';
  const literals = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);

  // --- format.ts holds exactly the literals this check knows, so a new one cannot ship unpinned. ---
  {
    const missing = EXPECTED.filter((l) => !literals.includes(l));
    const extra = literals.filter((l) => !EXPECTED.includes(l));
    if (missing.length > 0) fail('desktop-release', `format.ts's RELEASE_LITERALS is missing ${missing.map((l) => `'${l}'`).join(', ')}`);
    else if (extra.length > 0) fail('desktop-release', `format.ts's RELEASE_LITERALS carries ${extra.map((l) => `'${l}'`).join(', ')}, which has no pin against SKILL.md in scripts/checks/desktop-release.ts`);
    else ok();
  }

  // --- SKILL.md still spells every literal the app writes. ---
  for (const literal of EXPECTED) {
    if (!skill.includes(literal)) fail('desktop-release', `plugins/port/skills/release/SKILL.md no longer contains '${literal}', which apps/desktop/src/utils/release/format.ts writes`);
    else ok();
  }
}
