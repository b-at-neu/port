import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';
import { onTriggers } from './release.ts';

const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'];

// The installer build's own safety decisions: no SDK binary or fixture in a bundle, the audit always runs, and only the release workflow can write contents.
export default async function ({ expect }: Reporter) {
  const appDir = join(root, 'apps/desktop');
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
  const audit = await import(pathToFileURL(join(appDir, 'scripts/bundle-audit.mjs')).href);
  const modes = await import(pathToFileURL(join(appDir, 'scripts/fixture-modes.mjs')).href);
  const pkg = readJson('apps/desktop/package.json');
  const dist: string = pkg.scripts?.dist ?? '';

  // --- bundle-audit.mjs's pure rules must not pass vacuously on a clean listing, miss a bundled SDK binary, or miss a positive control. ---
  {
    const forbidden = audit.sdkPlatformPackages({ optionalDependencies: { '@anthropic-ai/claude-agent-sdk-linux-x64': '0.0.0', '@anthropic-ai/claude-agent-sdk-darwin-arm64': '0.0.0' } });
    expect(forbidden.length === 2, 'desktop-packaging', `sdkPlatformPackages(fixture) returned ${forbidden.length} packages, expected 2`);

    const required = ['/out/main/index.js', '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'];
    const clean = audit.auditEntries([...required, '/package.json'], forbidden);
    expect(clean.bundled.length === 0 && clean.missing.length === 0, 'desktop-packaging', `auditEntries on a clean listing reported ${JSON.stringify(clean)}`);
    const bundled = audit.auditEntries([...required, '/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'], forbidden);
    expect(bundled.bundled.length === 1, 'desktop-packaging', `auditEntries did not flag a bundled SDK platform binary: ${JSON.stringify(bundled)}`);
    const missing = audit.auditEntries(['/package.json'], forbidden);
    expect(missing.missing.includes('/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'desktop-packaging', `auditEntries did not report the missing sdk.mjs positive control: ${JSON.stringify(missing)}`);

    const text = read('apps/desktop/scripts/audit-bundle.mjs');
    expect(text.includes('asarArchivePath(entry, sep)') && !text.includes('extractFile(asarPath, entry.slice(1))'), 'desktop-packaging', 'audit-bundle.mjs must pass extractFile the native-separator path from asarArchivePath(entry, sep)');
  }

  // --- Only development, fixtures and smoke compile fixtures, the audit's sentinel names a real fixture literal, and `dist` builds in the default mode. ---
  {
    const cases: [string, boolean, boolean][] = [['production', false, false], ['unknown-mode', false, false], ['development', true, false], ['fixtures', true, false], ['smoke', true, true]];
    for (const [mode, compiled, packaged] of cases) {
      const got = modes.fixtureBuild(mode);
      expect(got.compiled === compiled && got.packaged === packaged, 'desktop-packaging', `fixtureBuild('${mode}') returned ${JSON.stringify(got)}, expected compiled=${compiled} packaged=${packaged}`);
    }
    expect(audit.fixtureLeaks([{ path: '/out/main/index.js', text: `x ${audit.FIXTURE_SENTINEL} y` }]).length === 1, 'desktop-packaging', 'fixtureLeaks did not flag a text containing the fixture sentinel');
    expect(audit.fixtureLeaks([{ path: '/out/main/index.js', text: 'const real = 1' }]).length === 0, 'desktop-packaging', 'fixtureLeaks flagged a text without the fixture sentinel');
    expect(read('apps/desktop/tests/fixtures/app/repos.ts').includes(audit.FIXTURE_SENTINEL), 'desktop-packaging', 'tests/fixtures/app/repos.ts no longer contains the fixture sentinel — the bundle audit would pass vacuously');

    for (const [entry, separator, expected] of [['/out/main/chunks/engine.js', '\\', 'out\\main\\chunks\\engine.js'], ['/out/main/index.js', '/', 'out/main/index.js']]) {
      const got = audit.asarArchivePath(entry, separator);
      expect(got === expected, 'desktop-packaging', `asarArchivePath(${JSON.stringify(entry)}, ${JSON.stringify(separator)}) returned ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }

    const winListing = ['port-1.0.0-win-x64.exe', 'port-1.0.0-win-x64.exe.blockmap', 'latest.yml'];
    const winYml = (name: string) => `files:\n  - url: ${name}\n`;
    expect(audit.updateMetadataGaps(winListing, () => winYml('port-1.0.0-win-x64.exe')).length === 0, 'desktop-packaging', 'updateMetadataGaps flagged a complete Windows listing');
    expect(audit.updateMetadataGaps(['port-1.0.0-win-x64.exe', 'latest.yml'], () => winYml('port-1.0.0-win-x64.exe')).length === 1, 'desktop-packaging', 'updateMetadataGaps did not flag a missing blockmap');
    expect(audit.updateMetadataGaps(winListing, () => winYml('other.exe')).length === 1, 'desktop-packaging', 'updateMetadataGaps did not flag a yml that does not name the installer');
    expect(audit.updateMetadataGaps([], () => '').length === 1, 'desktop-packaging', 'updateMetadataGaps passed an empty listing');

    const updateConfig = 'provider: github\nowner: acme\nrepo: widgets\n';
    expect(audit.appUpdateConfigGaps(updateConfig, { owner: 'acme', repo: 'widgets' }).length === 0, 'desktop-packaging', 'appUpdateConfigGaps flagged a good config');
    expect(audit.appUpdateConfigGaps(updateConfig, { owner: 'acme', repo: 'gadgets' }).length === 1, 'desktop-packaging', 'appUpdateConfigGaps did not flag a wrong repo');
    expect(audit.appUpdateConfigGaps('', { owner: 'acme', repo: 'widgets' }).length === 1, 'desktop-packaging', 'appUpdateConfigGaps passed empty text');

    expect(!/electron-vite build[^&]*--mode/.test(dist), 'desktop-packaging', `'dist' script must build in the default mode so no fixtures are compiled, got: ${dist}`);
    expect(dist.includes('--publish never'), 'desktop-packaging', `'dist' script must keep --publish never, got: ${dist}`);
    expect(/electron-builder[\s\S]*&&[\s\S]*audit-bundle\.mjs/.test(dist), 'desktop-packaging', `'dist' script must run audit-bundle.mjs after electron-builder in the same && chain, got: ${dist}`);
  }

  // --- electron-builder.config.mjs derives its exclusions, unpacks nothing, and names the product 'port', never 'Claude'. ---
  {
    const rel = 'apps/desktop/electron-builder.config.mjs';
    const text = read(rel);
    expect(text.includes('sdkPlatformPackages('), 'desktop-packaging', `${rel} must call sdkPlatformPackages( to derive its exclusions`);
    expect(!/\basarUnpack\b/.test(text), 'desktop-packaging', `${rel} must not set asarUnpack — there are no native production dependencies`);
    expect(/extraResources:\s*\[\s*\{\s*from:\s*['"]NOTICE\.txt['"]/.test(text), 'desktop-packaging', `${rel} must copy NOTICE.txt through extraResources`);
    expect(/provider:\s*['"]github['"]/.test(text), 'desktop-packaging', `${rel} must set a github publish provider so the build emits update metadata`);
    expect(/productName:\s*['"]port['"]/.test(text), 'desktop-packaging', `${rel}'s productName must be exactly 'port'`);
    for (const field of ['productName', 'appId', 'executableName']) {
      for (const m of text.matchAll(new RegExp(`${field}:\\s*['"\`]([^'"\`]*)['"\`]`, 'g'))) {
        expect(!/claude/i.test(m[1]), 'desktop-packaging', `${rel}'s ${field} ('${m[1]}') must not contain 'Claude'`);
      }
    }
  }

  // --- electron-updater is a runtime dependency — only `dependencies` ship in the asar. ---
  expect(pkg.dependencies?.['electron-updater'] !== undefined && pkg.devDependencies?.['electron-updater'] === undefined, 'desktop-packaging', 'apps/desktop/package.json must list electron-updater under dependencies and never devDependencies');

  // --- Each build workflow covers all three OSes; the packaging workflow has no push trigger. ---
  for (const [file, command] of [['desktop-package.yml', 'pnpm --filter @port/desktop dist'], ['desktop-release.yml', 'pnpm --filter @port/desktop dist'], ['e2e.yml', 'pnpm e2e']]) {
    const text = read(`.github/workflows/${file}`);
    expect(text.includes(command), 'desktop-packaging', `.github/workflows/${file} must run '${command}'`);
    for (const os of OSES) expect(text.includes(os), 'desktop-packaging', `.github/workflows/${file} must include '${os}' in its matrix`);
  }
  expect(!/^ {2}push:/m.test(read('.github/workflows/desktop-package.yml')), 'desktop-packaging', '.github/workflows/desktop-package.yml must not trigger on push');

  // --- The release workflow publishes installers and is the only workflow allowed `contents: write`. ---
  {
    const text = read('.github/workflows/desktop-release.yml');
    const triggers = onTriggers(text);
    expect(JSON.stringify(triggers) === JSON.stringify(['release', 'workflow_dispatch']), 'desktop-packaging', `.github/workflows/desktop-release.yml must trigger on exactly release and workflow_dispatch, got ${JSON.stringify(triggers)}`);
    for (const needle of ['gh release upload', '--clobber', 'contents: write', 'apps/desktop/dist/latest*.yml', '.blockmap']) {
      expect(text.includes(needle), 'desktop-packaging', `.github/workflows/desktop-release.yml must include '${needle}'`);
    }
    for (const file of readdirSync(join(root, '.github/workflows')).filter((f) => f.endsWith('.yml') && f !== 'desktop-release.yml')) {
      expect(!read(`.github/workflows/${file}`).includes('contents: write'), 'desktop-packaging', `.github/workflows/${file} must not grant contents: write — only desktop-release.yml may`);
    }
  }

  // --- Both package workflows read the version from the manifest port.config.json names. ---
  {
    const manifestPath: string | undefined = readJson('.claude/port.config.json').release?.versionFiles?.[0];
    expect(manifestPath !== undefined, 'desktop-packaging', '.claude/port.config.json has no release.versionFiles[0]');
    for (const file of ['desktop-package.yml', 'desktop-release.yml']) {
      expect(manifestPath !== undefined && read(`.github/workflows/${file}`).includes(manifestPath), 'desktop-packaging', `.github/workflows/${file} must read the version from ${manifestPath}`);
    }
  }

  // --- commands.checks never names e2e or screenshots — that list runs on every dispatched agent, and both launch Electron. ---
  {
    const checks: { run?: unknown }[] = readJson('.claude/port.config.json').commands?.checks ?? [];
    for (const name of ['e2e', 'screenshots']) {
      expect(!checks.some((c) => typeof c.run === 'string' && c.run.includes(name)), 'desktop-packaging', `.claude/port.config.json commands.checks names "${name}" — that list runs on every dispatched agent`);
    }
  }
}
