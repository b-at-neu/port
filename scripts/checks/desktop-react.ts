import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Four rails for the React renderer, each broken deliberately once before being trusted to pass.
export default async function ({ expect, fail, note, ok }: Reporter) {
  const rendererDir = 'apps/desktop/src/renderer';
  const ruleUrl = pathToFileURL(join(root, 'apps/desktop/eslint/no-raw-colour.mjs')).href;
  // A single dynamic import reads both pattern lists once for every block below that needs them.
  const mod = await import(ruleUrl);

  // --- Every no-raw-colour pattern rejects bad, accepts good — each pattern carries its own
  // good/bad pair, asserted both ways here. ---
  {
    const allPatterns = [...mod.COLOUR_PATTERNS, ...mod.CSS_COLOUR_PATTERNS];
    if (allPatterns.length === 0) {
      fail('desktop-react', 'no-raw-colour.mjs exports no patterns — the guard cannot pass vacuously if they are all removed');
    } else {
      for (const pattern of allPatterns) {
        const re = new RegExp(pattern.source, pattern.flags);
        if (re.test(pattern.good)) fail('desktop-react', `no-raw-colour pattern '${pattern.id}' matches its own good example ${JSON.stringify(pattern.good)}`);
        if (!re.test(pattern.bad)) fail('desktop-react', `no-raw-colour pattern '${pattern.id}' does not match its own bad example ${JSON.stringify(pattern.bad)}`);
      }
      ok();
    }
  }

  // --- No .css under renderer/ holds a colour value, except theme.css and the legacy
  // stylesheets — this exemption list only ever shrinks. ---
  {
    const cssPatterns = mod.CSS_COLOUR_PATTERNS as { source: string; flags: string; id: string }[];
    const exemptRel = new Set(
      ['board.css', 'claim.css', 'commands-strip.css', 'gate.css', 'index.css', 'permission.css', 'search.css', 'session-rail.css', 'session.css', 'transcript.css'].map(
        (f) => `${rendererDir}/src/${f}`,
      ),
    );
    exemptRel.add(`${rendererDir}/src/styles/theme.css`);

    for (const rel of exemptRel) {
      if (!existsAsFile(join(root, rel))) fail('desktop-react', `${rel} is in the legacy-stylesheet exemption list but does not exist on disk — shrink the list instead`);
    }

    const cssFiles = walk(join(root, rendererDir)).filter((f) => f.endsWith('.css'));
    let violated = false;
    for (const f of cssFiles) {
      const rel = relOf(f);
      if (exemptRel.has(rel)) continue;
      const text = readFileSync(f, 'utf8');
      for (const pattern of cssPatterns) {
        if (new RegExp(pattern.source, pattern.flags).test(text)) {
          violated = true;
          fail('desktop-react', `${rel} holds a colour value (${pattern.id}) — only styles/theme.css and the exempted legacy stylesheets may`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- window.port's push listeners are named only in data/subscriptions.ts — every other
  // push subscriber goes through that one module's `subscribe`. ---
  {
    const bridgeEventRe = /\.(onBoardUpdate|onSessionStatus|onSessionEntries)\b/;
    const subscriptionsRel = `${rendererDir}/src/data/subscriptions.ts`;
    const files = walk(join(root, rendererDir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));
    const matches = files.filter((f) => bridgeEventRe.test(readFileSync(f, 'utf8'))).map(relOf);
    if (!matches.includes(subscriptionsRel)) {
      fail('desktop-react', `${subscriptionsRel} does not name any window.port push-listener method — the guard cannot pass vacuously if it stops calling the bridge`);
    } else expect(!matches.some((rel) => rel !== subscriptionsRel), 'desktop-react', `window.port's push listeners are named outside ${subscriptionsRel}, in: ${matches.filter((rel) => rel !== subscriptionsRel).join(', ')}`);
  }

  // --- No useEffect/useLayoutEffect outside comments, non-test files — mirrors the ESLint
  // ban so the rail still holds in a worktree that never ran `pnpm install`. ---
  {
    const effectRe = /\buse(?:Effect|LayoutEffect)\b/;
    const files = walk(join(root, rendererDir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));
    let violated = false;
    for (const f of files) {
      const rel = relOf(f);
      // Strips /* */ blocks first, then every // line comment, so a mention inside either never counts.
      const withoutBlockComments = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const code = withoutBlockComments
        .split('\n')
        .map((line) => line.split('//')[0])
        .join('\n');
      if (effectRe.test(code)) {
        violated = true;
        fail('desktop-react', `${rel} names useEffect/useLayoutEffect outside a comment — the ban is total (#316)`);
      }
    }
    if (!violated) ok();
  }

  note(`desktop-react: scanned ${walk(join(root, rendererDir)).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.css')).length} renderer files`);
}

function existsAsFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}
