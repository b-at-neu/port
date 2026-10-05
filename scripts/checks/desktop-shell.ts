import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf, sectionText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ expect, fail, note, ok }: Reporter) {
  const designText = readFileSync(join(root, 'docs/DESIGN.md'), 'utf8');
  const shellDir = join(root, 'apps/desktop/src/renderer/src/shell');

  // --- pin: lib/phase.ts's PHASE_NAMES <-> DESIGN §6's role table ---------
  {
    const mod = await import(pathToFileURL(join(root, 'apps/desktop/src/renderer/src/lib/phase.ts')).href);
    const phaseNames: Record<string, string | null> = mod.PHASE_NAMES;
    const section = sectionText(designText, '6. Copy and tone');
    const fromDesign: Record<string, string | null> = {};
    for (const match of section.matchAll(/^\| (`[^|]+`) \| (.+?) \|$/gm)) {
      const name = match[2].startsWith('Not shown') ? null : match[2];
      for (const keyMatch of match[1].matchAll(/`([^`]+)`/g)) fromDesign[keyMatch[1]] = name;
    }
    fromDesign.marker = null;
    fromDesign.autoPlan = null;

    const codeKeys = Object.keys(phaseNames).sort();
    const designKeys = Object.keys(fromDesign).sort();
    if (JSON.stringify(codeKeys) !== JSON.stringify(designKeys)) {
      fail('desktop-shell', `lib/phase.ts's PHASE_NAMES keys and DESIGN.md §6's role table disagree — only in code: ${codeKeys.filter((k) => !designKeys.includes(k)).join(', ') || 'none'}, only in design: ${designKeys.filter((k) => !codeKeys.includes(k)).join(', ') || 'none'}`);
    } else {
      let mismatched = false;
      for (const key of codeKeys) {
        if (phaseNames[key] !== fromDesign[key]) {
          mismatched = true;
          fail('desktop-shell', `lib/phase.ts's PHASE_NAMES.${key} is ${JSON.stringify(phaseNames[key])}, DESIGN.md §6 names it ${JSON.stringify(fromDesign[key])}`);
        }
      }
      if (!mismatched) ok();
    }
  }

  // --- pin: shell/key-bindings.ts's KEY_BINDINGS <-> DESIGN §3's keyboard table
  {
    const mod = await import(pathToFileURL(join(root, 'apps/desktop/src/renderer/src/shell/key-bindings.ts')).href);
    const codeKeys = (mod.KEY_BINDINGS as { readonly keys: string }[]).map((b) => b.keys).sort();
    const layoutSection = sectionText(designText, '3. Layout');
    const keyboardText = layoutSection.slice(layoutSection.indexOf('**Keyboard:**'));
    const designKeys = Array.from(keyboardText.matchAll(/^\| ([^|]+) \| [^|]+ \|$/gm))
      .map((m) => m[1].trim())
      .filter((k) => k !== 'Keys' && !/^-+$/.test(k))
      .sort();
    expect(!(JSON.stringify(codeKeys) !== JSON.stringify(designKeys)), 'desktop-shell', `shell/key-bindings.ts's KEY_BINDINGS and DESIGN.md §3's keyboard table disagree — only in code: ${codeKeys.filter((k) => !designKeys.includes(k)).join(', ') || 'none'}, only in design: ${designKeys.filter((k) => !codeKeys.includes(k)).join(', ') || 'none'}`);
  }

  // --- guard: no data-action= under shell/, backlog/, components/ ---------
  {
    const scanDirs = ['apps/desktop/src/renderer/src/shell', 'apps/desktop/src/renderer/src/backlog', 'apps/desktop/src/renderer/src/components'];
    let violated = false;
    for (const dir of scanDirs) {
      for (const f of walk(join(root, dir)).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
        if (/data-action=/.test(readFileSync(f, 'utf8'))) {
          violated = true;
          fail('desktop-shell', `${relOf(f)} sets data-action — legacy #app click delegation matches on it, which would fire a real legacy action`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- guard: shared/board/needs-you.ts imports nothing from main/ or node: ---
  {
    const file = join(root, 'apps/desktop/src/shared/board/needs-you.ts');
    const imports = Array.from(readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)'/gm)).map((m) => m[1]);
    const bad = imports.filter((spec) => spec.startsWith('node:') || spec.includes('/main/'));
    expect(!(bad.length > 0), 'desktop-shell', `shared/board/needs-you.ts imports from ${bad.join(', ')} — it must stay renderer-safe`);
  }

  note(`desktop-shell: scanned ${walk(shellDir).length} shell files`);
}
