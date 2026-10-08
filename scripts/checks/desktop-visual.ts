import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The visual harness's own rails — each block opens with the failure it catches.

const FIXTURES_DIR = 'apps/desktop/src/main/fixtures';

// Every allowed import specifier a production file under main/fixtures/ may use — anything else would let fixture mode reach `gh` or `claude`.
const ALLOWED_FIXTURE_IMPORTS: readonly RegExp[] = [
  /^electron$/,
  /^node:path$/,
  /^\.\//,
  /^\.\.\/\.\.\/shared\//,
  /^\.\.\/registry\/schema$/,
  /^\.\.\/state\/reconcile$/,
  /^\.\.\/tick\/ledger$/,
  /^\.\.\/tick\/plan$/,
];

const IMPORT_RE = /^\s*import\s+(?:type\s+)?[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm;

export default async function ({ expect, fail, note, ok }: Reporter) {
  // --- main/fixtures/ imports stay inside the allowlist, keeping fixture mode unable to
  // reach `gh` or `claude`. ---
  {
    const files = walk(join(root, FIXTURES_DIR)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    if (files.length === 0) {
      fail('desktop-visual', `${FIXTURES_DIR} holds no production .ts files — the import-boundary guard cannot pass vacuously if the directory is emptied`);
    } else {
      let violated = false;
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        for (const match of text.matchAll(IMPORT_RE)) {
          const specifier = match[1];
          if (specifier === undefined) continue;
          if (!ALLOWED_FIXTURE_IMPORTS.some((re) => re.test(specifier))) {
            violated = true;
            fail('desktop-visual', `${relOf(f)} imports '${specifier}', outside main/fixtures/'s own allowlist — fixture mode must never reach gh or claude`);
          }
        }
      }
      if (!violated) ok();
    }
  }

  // --- main/index.ts passes app.isPackaged to fixtureMode( — without this, a packaged
  // build could still read PORT_FIXTURES and serve canned data. ---
  {
    const text = readFileSync(join(root, 'apps/desktop/src/main/index.ts'), 'utf8');
    if (/fixtureMode\(\s*process\.env\s*,\s*app\.isPackaged\s*,/.test(text)) {
      ok();
    } else {
      fail('desktop-visual', 'apps/desktop/src/main/index.ts does not call fixtureMode( with app.isPackaged as its second argument');
    }
  }

  // --- router.tsx's own paths stay inside ROUTE_IDS, '/' or '*' — a literal path would
  // escape visual/targets.mts's exhaustive capture/skip table. ---
  {
    const text = readFileSync(join(root, 'apps/desktop/src/renderer/src/router/router.tsx'), 'utf8');
    const assignments = [...text.matchAll(/\bpath:\s*([^,}\n]+)/g)].map((m) => (m[1] ?? '').trim());
    const bad = assignments.filter((p) => p !== "'/'" && p !== "'*'" && !/^ROUTE_IDS\.\w+$/.test(p));
    if (assignments.length === 0) {
      fail('desktop-visual', "router.tsx carries no 'path:' assignment at all — the guard cannot pass vacuously if the router is rewritten");
    } else expect(!(bad.length > 0), 'desktop-visual', `router.tsx names a route path outside ROUTE_IDS/'/'/'*' : ${bad.join(', ')}`);
  }

  // --- commands.checks never names "screenshots" — that list runs on every dispatched agent, and this command launches Electron. ---
  {
    const config = readJson('.claude/port.config.json');
    const checksList: unknown = config?.commands?.checks;
    const names = Array.isArray(checksList)
      ? checksList.some((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { run?: unknown }).run === 'string' && (entry as { run: string }).run.includes('screenshots'))
      : false;
    expect(!names, 'desktop-visual', '.claude/port.config.json commands.checks names "screenshots" — that list runs on every dispatched agent');
  }

  // --- visual/targets.mts's ROUTE_KEYS matches the real ROUTE_IDS, both ways
  // pin: `visual/targets.mts`'s `ROUTE_KEYS` ↔ `router/routes.ts`'s `ROUTE_IDS` keys, both directions
  {
    const targetsUrl = pathToFileURL(join(root, 'apps/desktop/visual/targets.mts')).href;
    const routesUrl = pathToFileURL(join(root, 'apps/desktop/src/renderer/src/router/routes.ts')).href;
    const targetsMod: { SCREENSHOT_TARGETS?: Record<string, unknown> } = await import(targetsUrl);
    const routesMod: { ROUTE_IDS?: Record<string, unknown> } = await import(routesUrl);
    const targetKeys = new Set(Object.keys(targetsMod.SCREENSHOT_TARGETS ?? {}));
    const routeKeys = new Set(Object.keys(routesMod.ROUTE_IDS ?? {}));
    const onlyInTargets = [...targetKeys].filter((k) => !routeKeys.has(k));
    const onlyInRoutes = [...routeKeys].filter((k) => !targetKeys.has(k));
    if (targetKeys.size === 0 || routeKeys.size === 0) {
      fail('desktop-visual', 'could not read SCREENSHOT_TARGETS or ROUTE_IDS as a non-empty object — the pin cannot pass vacuously if either export is removed');
    } else expect(!(onlyInTargets.length > 0 || onlyInRoutes.length > 0), 'desktop-visual', `visual/targets.mts's ROUTE_KEYS and router/routes.ts's ROUTE_IDS disagree — only in targets: [${onlyInTargets.join(', ')}], only in ROUTE_IDS: [${onlyInRoutes.join(', ')}]`);
  }

  // pin: `visual/targets.mts`'s `SCREENSHOT_DIR` ↔ `.github/workflows/visual.yml`, the root
  // `package.json` script, and `docs/DESIGN.md` §7, all naming the same command and path.
  {
    const targetsText = readFileSync(join(root, 'apps/desktop/visual/targets.mts'), 'utf8');
    const workflowText = readFileSync(join(root, '.github/workflows/visual.yml'), 'utf8');
    const rootPackageText = readFileSync(join(root, 'package.json'), 'utf8');
    const designText = readFileSync(join(root, 'docs/DESIGN.md'), 'utf8');

    let violated = false;
    if (!targetsText.includes("SCREENSHOT_DIR = 'out/screenshots'")) {
      violated = true;
      fail('desktop-visual', "visual/targets.mts no longer pins SCREENSHOT_DIR = 'out/screenshots'");
    }
    if (!workflowText.includes('pnpm screenshots') || !workflowText.includes('apps/desktop/out/screenshots') || !workflowText.includes('name: screenshots')) {
      violated = true;
      fail('desktop-visual', ".github/workflows/visual.yml no longer pins 'pnpm screenshots' / 'apps/desktop/out/screenshots' / 'name: screenshots' together");
    }
    if (!rootPackageText.includes('"screenshots"')) {
      violated = true;
      fail('desktop-visual', 'the root package.json no longer carries a "screenshots" script');
    }
    if (!designText.includes('pnpm screenshots') || !designText.includes('apps/desktop/out/screenshots') || !designText.includes('visual/targets.mts')) {
      violated = true;
      fail('desktop-visual', "docs/DESIGN.md §7 no longer names 'pnpm screenshots' / 'apps/desktop/out/screenshots' / 'visual/targets.mts'");
    }
    if (!violated) ok();
  }

  note(`desktop-visual: scanned ${walk(join(root, FIXTURES_DIR)).length} fixture files`);
}
