import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Three mechanical assertions over the operator session defaults allowlist,
// split from desktop-hosting.ts purely to stay under its own 500-line ceiling.
export default async function ({ fail, ok }: Reporter) {
  const hostingDir = 'apps/desktop/src/main/hosting';
  const sharedHostingDir = 'apps/desktop/src/shared/hosting';
  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  const typesFile = allFiles.find((f) => relOf(f) === `${sharedHostingDir}/types.ts`);
  const optionsFile = allFiles.find((f) => relOf(f) === `${hostingDir}/options.ts`);
  const persistFile = allFiles.find((f) => relOf(f) === `${hostingDir}/persist.ts`);
  const hostingChannelFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/main/channels/hosting.ts');

  if (!typesFile || !optionsFile || !persistFile || !hostingChannelFile) {
    fail('desktop-hosting-defaults', 'one of types.ts/options.ts/persist.ts/channels/hosting.ts does not exist');
    return;
  }

  // guard: SESSION_PERMISSION_MODES must stay exactly {default, acceptEdits, plan}, both directions.
  {
    const match = /export const SESSION_PERMISSION_MODES\s*=\s*\[([^\]]+)\]/.exec(readFileSync(typesFile, 'utf8'));
    const members = match ? new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])) : null;
    const expected = new Set(['default', 'acceptEdits', 'plan']);
    if (members === null || [...members].some((m) => !expected.has(m)) || [...expected].some((m) => !members.has(m))) {
      fail('desktop-hosting-defaults', `${sharedHostingDir}/types.ts's SESSION_PERMISSION_MODES must be exactly {default, acceptEdits, plan}`);
    } else {
      ok();
    }
  }

  // guard: the dispatcher/operator ternary must stay one permissionMode: line naming 'default'.
  {
    const lines = stripComments(readFileSync(optionsFile, 'utf8'))
      .split('\n')
      .filter((line) => /\bpermissionMode\s*:/.test(line));
    if (lines.length !== 1 || !/'default'/.test(lines[0] ?? '')) {
      fail('desktop-hosting-defaults', `${hostingDir}/options.ts must name 'permissionMode:' on exactly one line, which also names 'default'`);
    } else {
      ok();
    }
  }

  // guard: persist.ts and channels/hosting.ts both import the allowlist rather than re-deriving it.
  {
    if (!/SESSION_PERMISSION_MODES/.test(readFileSync(persistFile, 'utf8')) || !/SESSION_PERMISSION_MODES/.test(readFileSync(hostingChannelFile, 'utf8'))) {
      fail('desktop-hosting-defaults', `${hostingDir}/persist.ts and main/channels/hosting.ts must both name 'SESSION_PERMISSION_MODES'`);
    } else {
      ok();
    }
  }
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
