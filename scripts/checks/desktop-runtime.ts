import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// #97: apps/desktop/src/main/runtime/ is the composition root for the SDK
// runtime adapter. Five assertions pin its plan's decisions mechanically, in
// the shape desktop-registry.ts's and desktop-sessions.ts's own guards
// already use.
export default async function ({ fail, ok }: Reporter) {
  const srcDir = join(root, 'apps/desktop/src');
  const runtimeDir = 'apps/desktop/src/main/runtime';
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  const typesFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/shared/runtime/types.ts');
  const copyFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/shared/runtime/copy.ts');

  // --- Every RuntimeDiagnosis member has a copy.ts entry, both directions ---
  // guard(#97): a diagnosis added to the union with no operator-facing copy,
  // or a copy entry left behind for a diagnosis that no longer exists.
  // pin: `shared/runtime/types.ts`'s `RuntimeDiagnosis` ↔ `shared/runtime/copy.ts`'s `RUNTIME_COPY`, both directions
  {
    if (!typesFile || !copyFile) {
      fail('desktop-runtime', 'shared/runtime/types.ts or shared/runtime/copy.ts does not exist');
    } else {
      const typesText = readFileSync(typesFile, 'utf8');
      const copyText = readFileSync(copyFile, 'utf8');
      const unionMatch = /export type RuntimeDiagnosis\s*=\s*([^\n]+)/.exec(typesText);
      const copyMatch = /export const RUNTIME_COPY:[^=]*=\s*\{([\s\S]*?)\n\}/.exec(copyText);
      if (!unionMatch) {
        fail('desktop-runtime', 'shared/runtime/types.ts has no `export type RuntimeDiagnosis = ...` declaration');
      } else if (!copyMatch) {
        fail('desktop-runtime', 'shared/runtime/copy.ts has no `export const RUNTIME_COPY = { ... }` declaration');
      } else {
        const members = new Set([...unionMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
        const keys = new Set([...copyMatch[1].matchAll(/^\s{2}(?:'([^']+)'|([a-zA-Z]+)):\s*\{/gm)].map((m) => m[1] ?? m[2]));
        for (const member of members) {
          if (!keys.has(member)) fail('desktop-runtime', `RUNTIME_COPY has no entry for RuntimeDiagnosis member '${member}'`);
        }
        for (const key of keys) {
          if (!members.has(key)) fail('desktop-runtime', `RUNTIME_COPY has an entry '${key}' naming no RuntimeDiagnosis member`);
        }
        if (members.size > 0 && [...members].every((m) => keys.has(m)) && [...keys].every((k) => members.has(k))) ok();

        // --- unauthenticated/token-stale: no 'API key' wording, both carry the login action ---
        // guard(#97, #145): the two-week failure recorded there was exactly
        // one of these being misread as an API key problem.
        let loginEntriesOk = true;
        const loginEntryPatterns: [string, RegExp][] = [
          ['unauthenticated', /unauthenticated:\s*\{([^}]*)\}/],
          ['token-stale', /'token-stale':\s*\{([^}]*)\}/],
        ];
        for (const [name, pattern] of loginEntryPatterns) {
          const entryMatch = pattern.exec(copyText);
          if (!entryMatch) {
            loginEntriesOk = false;
            fail('desktop-runtime', `RUNTIME_COPY has no '${name}' entry`);
            continue;
          }
          const block = entryMatch[1];
          if (/api key/i.test(block)) {
            loginEntriesOk = false;
            fail('desktop-runtime', `RUNTIME_COPY's '${name}' entry mentions an API key — #145 was exactly this misreading`);
          }
          if (!/action:\s*'login'/.test(block)) {
            loginEntriesOk = false;
            fail('desktop-runtime', `RUNTIME_COPY's '${name}' entry must carry action: 'login'`);
          }
        }
        if (loginEntriesOk) ok();
      }
    }
  }

  // --- MINIMUM_CLAUDE_CODE_VERSION is declared once, and version.ts imports it ---
  // guard(#97): a second literal minimum retyped at the comparison site
  // instead of importing the one declared constant.
  {
    const declarations = allFiles.filter((f) => !f.endsWith('.test.ts') && /export const MINIMUM_CLAUDE_CODE_VERSION\s*=/.test(readFileSync(f, 'utf8')));
    if (declarations.length !== 1) {
      fail('desktop-runtime', `MINIMUM_CLAUDE_CODE_VERSION is declared ${declarations.length} times, expected exactly 1: ${declarations.map(relOf).join(', ') || '(none)'}`);
    } else {
      ok();
    }
    const versionFile = allFiles.find((f) => relOf(f) === `${runtimeDir}/version.ts`);
    if (!versionFile) {
      fail('desktop-runtime', `${runtimeDir}/version.ts does not exist`);
    } else if (!/MINIMUM_CLAUDE_CODE_VERSION/.test(readFileSync(versionFile, 'utf8'))) {
      fail('desktop-runtime', `${runtimeDir}/version.ts does not reference MINIMUM_CLAUDE_CODE_VERSION`);
    } else {
      ok();
    }
  }

  // --- Every real query( call site passes pathToClaudeCodeExecutable -------
  // guard(#97): a probe call site silently letting the SDK fall back to its
  // own bundled binary instead of the resolved operator install.
  {
    const queryCallRe = /\bquery\(\s*\{/;
    const matches = allFiles.filter((f) => !f.endsWith('.test.ts') && queryCallRe.test(readFileSync(f, 'utf8')));
    if (matches.length === 0) {
      fail('desktop-runtime', 'no query({ call site exists under apps/desktop/src/ — the guard cannot pass vacuously if it is removed');
    } else {
      for (const f of matches) {
        const text = readFileSync(f, 'utf8');
        if (!text.includes('pathToClaudeCodeExecutable')) {
          fail('desktop-runtime', `${relOf(f)} calls query({ without ever passing pathToClaudeCodeExecutable`);
        }
      }
      ok();
    }
  }

  // --- classify.cases.json resolves every case against a real export ------
  // guard(#97): a case naming a function classify.ts no longer exports,
  // silently skipped rather than failing loudly.
  // pin: `main/runtime/classify.cases.json` ↔ `classifyPreflight`/`classifyProbeFailure` in `main/runtime/classify.ts`
  {
    const classifyFile = allFiles.find((f) => relOf(f) === `${runtimeDir}/classify.ts`);
    const casesPath = `${runtimeDir}/classify.cases.json`;
    if (!classifyFile) {
      fail('desktop-runtime', `${runtimeDir}/classify.ts does not exist`);
    } else {
      const text = readFileSync(classifyFile, 'utf8');
      const cases = readJson(casesPath);
      const fns = new Set<string>(cases.map((c: any) => c.fn));
      if (fns.size === 0) {
        fail('desktop-runtime', `${casesPath} names no cases`);
      } else {
        for (const fn of fns) {
          if (!new RegExp(`export function ${fn}\\(`).test(text)) {
            fail('desktop-runtime', `${casesPath} names '${fn}', which ${runtimeDir}/classify.ts does not export`);
          }
        }
        ok();
      }
    }
  }
}
