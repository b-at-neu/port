import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, relOf } from '#lib/files.ts';
import { forbid, srcFiles } from '#lib/source.ts';
import type { Reporter } from '#lib/report.ts';

const INDEX_REL = 'apps/desktop/src/main/index.ts';
const THEME_REL = 'apps/desktop/src/renderer/styles/theme.css';

// Safety properties of the desktop app that no type, lint rule or unit test can see: a packaged build never honours a fixture or e2e switch, and colour lives only in the theme.
export default async function ({ expect, fail, ok }: Reporter) {
  // --- main/index.ts passes app.isPackaged to both mode readers and reaches fixtures only through '#app-fixtures' — a packaged build would otherwise read PORT_E2E or PORT_FIXTURES. ---
  {
    const text = readFileSync(join(root, INDEX_REL), 'utf8');
    for (const reader of ['e2eMode', 'fixtureMode']) {
      expect(new RegExp(`${reader}\\(\\s*process\\.env\\s*,\\s*app\\.isPackaged\\s*,`).test(text), 'desktop-safety', `${INDEX_REL} does not call ${reader}( with app.isPackaged as its second argument`);
    }
    expect(/from\s*'#app-fixtures'/.test(text), 'desktop-safety', `${INDEX_REL} must reach the fixtures through the '#app-fixtures' alias`);
  }

  // --- No stylesheet under renderer/ except theme.css holds a colour value — colour comes only from theme roles. ---
  {
    const { CSS_COLOUR_PATTERNS } = (await import(pathToFileURL(join(root, 'apps/desktop/eslint/no-raw-colour.mjs')).href)) as { CSS_COLOUR_PATTERNS: { source: string; flags: string; id: string }[] };
    const files = srcFiles('apps/desktop/src/renderer', { exts: ['.css'] }).filter((f) => relOf(f) !== THEME_REL);
    forbid({ fail, ok }, 'desktop-safety', files, (text) => {
      const hit = CSS_COLOUR_PATTERNS.find((p) => new RegExp(p.source, p.flags).test(text));
      return hit ? `holds a colour value (${hit.id}) — only ${THEME_REL} may` : null;
    });
  }
}
