import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// #335: electron-builder.config.mjs and apps/desktop/scripts/ are the
// packaging boundary. These assertions pin the installer build's own
// decisions mechanically, the same shape desktop-runtime.ts's own guards
// already use.
export default async function ({ expect, fail, ok }: Reporter) {
  const appDir = join(root, 'apps/desktop');
  const noticePath = join(appDir, 'NOTICE.txt');
  const configPath = join(appDir, 'electron-builder.config.mjs');
  const packageJsonPath = join(appDir, 'package.json');
  const workflowPath = join(root, '.github/workflows/desktop-package.yml');

  // --- NOTICE.txt's two lines ↔ DESIGN.md §6's About: line, both directions
  // guard(#335): the installer notice drifting from the app's own "Powered
  // by Claude" copy would ship two different postures in two places.
  // pin: `apps/desktop/NOTICE.txt` ↔ `docs/DESIGN.md` §6's `About:` line
  {
    const designText = readFileSync(join(root, 'docs/DESIGN.md'), 'utf8');
    const aboutMatch = /About: "([^"]+)", and "([^"]+)"/.exec(designText);
    if (!aboutMatch) {
      fail('desktop-packaging', "docs/DESIGN.md §6 has no About: \"...\", and \"...\" line to pin NOTICE.txt against");
    } else if (!existsSync(noticePath)) {
      fail('desktop-packaging', `${relOf(noticePath)} does not exist`);
    } else {
      const noticeLines = readFileSync(noticePath, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
      const [designLine1, designLine2] = [aboutMatch[1], aboutMatch[2]];
      if (noticeLines.length !== 2) {
        fail('desktop-packaging', `${relOf(noticePath)} must carry exactly two lines, found ${noticeLines.length}`);
      } else expect(!(noticeLines[0] !== designLine1 || noticeLines[1] !== designLine2), 'desktop-packaging', `${relOf(noticePath)} (${JSON.stringify(noticeLines)}) does not match docs/DESIGN.md §6's About: line (${JSON.stringify([designLine1, designLine2])})`);
    }
  }

  // --- bundle-audit.mjs's pure rules, exercised with no node_modules -------
  // guard(#335): the audit passing vacuously on a clean listing, failing to
  // flag a bundled SDK binary, or failing to report a missing positive
  // control would all silently defeat the "no Claude binary ships" promise.
  {
    const bundleAuditPath = join(appDir, 'scripts/bundle-audit.mjs');
    if (!existsSync(bundleAuditPath)) {
      fail('desktop-packaging', `${relOf(bundleAuditPath)} does not exist`);
    } else {
      const mod = await import(pathToFileURL(bundleAuditPath).href);
      if (typeof mod.readSdkManifest !== 'function' || typeof mod.sdkPlatformPackages !== 'function' || typeof mod.auditEntries !== 'function') {
        fail('desktop-packaging', `${relOf(bundleAuditPath)} must export readSdkManifest, sdkPlatformPackages and auditEntries`);
      } else {
        const fixtureManifest = {
          optionalDependencies: {
            '@anthropic-ai/claude-agent-sdk-linux-x64': '0.0.0',
            '@anthropic-ai/claude-agent-sdk-darwin-arm64': '0.0.0',
          },
        };
        const forbidden = mod.sdkPlatformPackages(fixtureManifest);
        expect(!(forbidden.length !== 2), 'desktop-packaging', `sdkPlatformPackages(fixture) returned ${forbidden.length} packages, expected 2`);

        const requiredEntries = ['/out/main/index.js', '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'];

        const clean = mod.auditEntries([...requiredEntries, '/package.json'], forbidden);
        expect(!(clean.bundled.length !== 0 || clean.missing.length !== 0), 'desktop-packaging', `auditEntries on a clean listing reported ${JSON.stringify(clean)}, expected empty bundled and missing`);

        const bundledCase = mod.auditEntries([...requiredEntries, '/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'], forbidden);
        expect(!(bundledCase.bundled.length !== 1), 'desktop-packaging', `auditEntries did not flag a bundled SDK platform binary: ${JSON.stringify(bundledCase)}`);

        const missingCase = mod.auditEntries(['/package.json'], forbidden);
        expect(missingCase.missing.includes('/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'desktop-packaging', `auditEntries did not report the missing sdk.mjs positive control: ${JSON.stringify(missingCase)}`);
      }
    }
  }

  // --- electron-builder.config.mjs derives exclusions and excludes no asarUnpack
  // guard(#335): a hand-typed exclusion list or a reintroduced asarUnpack
  // would silently defeat the derive-from-the-manifest contract.
  {
    if (!existsSync(configPath)) {
      fail('desktop-packaging', `${relOf(configPath)} does not exist`);
    } else {
      const text = readFileSync(configPath, 'utf8');
      expect(text.includes('sdkPlatformPackages('), 'desktop-packaging', `${relOf(configPath)} must call sdkPlatformPackages( to derive its exclusions`);
      expect(!/\basarUnpack\b/.test(text), 'desktop-packaging', `${relOf(configPath)} must not set asarUnpack — there are no native production dependencies`);
      expect(/extraResources:\s*\[\s*\{\s*from:\s*['"]NOTICE\.txt['"]/.test(text), 'desktop-packaging', `${relOf(configPath)} must copy NOTICE.txt through extraResources`);

      // --- productName/appId/executableName name 'port', never 'Claude' ---
      // guard(#335): DESIGN.md "Identity" — the installed app must never
      // present itself as a Claude product.
      const productNameMatch = /productName:\s*['"]([^'"]+)['"]/.exec(text);
      expect(!(!productNameMatch || productNameMatch[1] !== 'port'), 'desktop-packaging', `${relOf(configPath)}'s productName must be exactly 'port'`);
      for (const field of ['productName', 'appId', 'executableName']) {
        const matches = [...text.matchAll(new RegExp(`${field}:\\s*['"\`]([^'"\`]*)['"\`]`, 'g'))];
        for (const m of matches) {
          if (/claude/i.test(m[1])) {
            fail('desktop-packaging', `${relOf(configPath)}'s ${field} ('${m[1]}') must not contain 'Claude'`);
          }
        }
      }
      ok();
    }
  }

  // --- dist script runs audit-bundle.mjs after electron-builder -----------
  // guard(#335): an installer that skips the audit on some path ships
  // unchecked, silently restoring the bundled-binary risk this ticket closes.
  {
    if (!existsSync(packageJsonPath)) {
      fail('desktop-packaging', `${relOf(packageJsonPath)} does not exist`);
    } else {
      const pkg = readJson('apps/desktop/package.json');
      const dist: string | undefined = pkg.scripts?.dist;
      if (!dist) {
        fail('desktop-packaging', `${relOf(packageJsonPath)} has no 'dist' script`);
      } else expect(/electron-builder[\s\S]*&&[\s\S]*audit-bundle\.mjs/.test(dist), 'desktop-packaging', `'dist' script must run audit-bundle.mjs after electron-builder in the same && chain, got: ${dist}`);
    }
  }

  // --- the packaging workflow runs the three-OS matrix ---------------------
  // guard(#335): a workflow that silently dropped an OS would stop proving
  // the "unsigned installers build on all three OSes" done-when criterion.
  {
    if (!existsSync(workflowPath)) {
      fail('desktop-packaging', `${relOf(workflowPath)} does not exist`);
    } else {
      const text = readFileSync(workflowPath, 'utf8');
      expect(/pnpm --filter @port\/desktop dist/.test(text), 'desktop-packaging', `${relOf(workflowPath)} must run 'pnpm --filter @port/desktop dist'`);
      for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
        if (!text.includes(os)) {
          fail('desktop-packaging', `${relOf(workflowPath)} must include '${os}' in its matrix`);
        }
      }
      ok();
    }
  }
}
