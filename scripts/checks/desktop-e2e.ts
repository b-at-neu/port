import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// The E2E harness's own rails — each block opens with the failure it catches.

export default async function ({ expect, fail, ok }: Reporter) {
  // --- main/index.ts passes app.isPackaged to e2eMode( — without this, a packaged build
  // could still read PORT_E2E and route every command to the fake. ---
  {
    const text = readFileSync(join(root, 'apps/desktop/src/main/index.ts'), 'utf8');
    if (/e2eMode\(\s*process\.env\s*,\s*app\.isPackaged\s*,/.test(text)) {
      ok();
    } else {
      fail('desktop-e2e', 'apps/desktop/src/main/index.ts does not call e2eMode( with app.isPackaged as its second argument');
    }
  }

  // --- commands.checks never names "e2e" — that list runs on every dispatched agent, and
  // this command launches Electron. ---
  {
    const config = readJson('.claude/port.config.json');
    const checksList: unknown = config?.commands?.checks;
    const names = Array.isArray(checksList)
      ? checksList.some((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { run?: unknown }).run === 'string' && (entry as { run: string }).run.includes('e2e'))
      : false;
    expect(!names, 'desktop-e2e', '.claude/port.config.json commands.checks names "e2e" — that list runs on every dispatched agent');
  }

  // --- the E2E workflow pins `pnpm e2e` and all three OSes — a matrix entry quietly dropped
  // would stop testing a whole platform with nothing failing loudly. ---
  {
    const workflowText = readFileSync(join(root, '.github/workflows/e2e.yml'), 'utf8');
    const hasCommand = workflowText.includes('pnpm e2e');
    const hasAllOses = ['ubuntu-latest', 'macos-latest', 'windows-latest'].every((os) => workflowText.includes(os));
    expect(hasCommand && hasAllOses, 'desktop-e2e', ".github/workflows/e2e.yml no longer pins 'pnpm e2e' together with all three OSes (ubuntu-latest, macos-latest, windows-latest)");
  }

  // --- the root package.json and apps/desktop/package.json both carry an "e2e" script ----
  {
    const rootPackageText = readFileSync(join(root, 'package.json'), 'utf8');
    const desktopPackageText = readFileSync(join(root, 'apps/desktop/package.json'), 'utf8');
    expect(rootPackageText.includes('"e2e"') && desktopPackageText.includes('"e2e"'), 'desktop-e2e', 'the root package.json or apps/desktop/package.json no longer carries an "e2e" script');
  }

  // --- run.ts stays the only child_process importer under src/ — the E2E route depends on
  // every subprocess call funneling through it so e2eMode can intercept it. ---
  {
    const files = walk(join(root, 'apps/desktop/src')).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts'));
    let violated = false;
    let scanned = 0;
    for (const f of files) {
      const rel = relOf(f);
      if (rel === 'apps/desktop/src/main/platform/run.ts') continue;
      scanned++;
      const text = readFileSync(f, 'utf8');
      if (/\bfrom\s+['"](?:node:)?child_process['"]|\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/.test(text)) {
        violated = true;
        fail('desktop-e2e', `${rel} imports child_process directly — route subprocess calls through apps/desktop/src/main/platform/run.ts`);
      }
    }
    if (scanned === 0) fail('desktop-e2e', 'no files scanned under apps/desktop/src (besides run.ts) — the guard cannot pass vacuously');
    else if (!violated) ok();
  }
}
