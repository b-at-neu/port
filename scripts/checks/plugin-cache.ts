// Unit-tests classify()/assertFenced() directly, then spawns the real CLI
// against fixture homes for the report/apply split and the backup.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { message } from '../lib/errors.ts';

export default async function ({ expect, fail, note, ok }: Reporter) {
  const scriptPath = join(root, 'plugins/port/bin/plugin-cache.mjs');
  const { classify, assertFenced }: { classify: (args: any) => any; assertFenced: (path: string, home: string, plugins: string[]) => boolean } = await import(pathToFileURL(scriptPath).href);

  // --- classify(): unit cases, no I/O --------------------------------------
  {
    const exists = (p: string) => p === '/live/project';

    const cases: [string, any, { deadKeys: string[]; liveKeys: string[]; unreferenced: string[] }][] = [
      [
        'dead local record',
        {
          installed: { k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: '/dead/project', installPath: '/home/plugins/cache/port/port/0.1.0' }] },
          cacheDirs: [{ marketplace: 'port', plugin: 'port', version: '0.1.0', path: '/home/plugins/cache/port/port/0.1.0' }],
        },
        { deadKeys: ['k1'], liveKeys: [], unreferenced: ['/home/plugins/cache/port/port/0.1.0'] },
      ],
      [
        'dead project-scope record from a different repo path',
        {
          installed: { k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'project', projectPath: '/some/other/repo', installPath: '/home/plugins/cache/port/port/0.2.0' }] },
          cacheDirs: [{ marketplace: 'port', plugin: 'port', version: '0.2.0', path: '/home/plugins/cache/port/port/0.2.0' }],
        },
        { deadKeys: ['k1'], liveKeys: [], unreferenced: ['/home/plugins/cache/port/port/0.2.0'] },
      ],
      [
        'live record pins a version',
        {
          installed: { k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: '/live/project', installPath: '/home/plugins/cache/port/port/0.3.0' }] },
          cacheDirs: [{ marketplace: 'port', plugin: 'port', version: '0.3.0', path: '/home/plugins/cache/port/port/0.3.0' }],
        },
        { deadKeys: [], liveKeys: ['k1'], unreferenced: [] },
      ],
      [
        'user-scope record is never dead',
        {
          installed: { k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'user', projectPath: null, installPath: '/home/plugins/cache/port/port/0.4.0' }] },
          cacheDirs: [{ marketplace: 'port', plugin: 'port', version: '0.4.0', path: '/home/plugins/cache/port/port/0.4.0' }],
        },
        { deadKeys: [], liveKeys: ['k1'], unreferenced: [] },
      ],
      [
        'non-port plugin with a dead path is untouched (outside the key filter)',
        {
          installed: { k1: [{ marketplaceName: 'other', pluginName: 'thing', scope: 'local', projectPath: '/dead/project', installPath: '/home/plugins/cache/other/thing/0.1.0' }] },
          cacheDirs: [{ marketplace: 'other', plugin: 'thing', version: '0.1.0', path: '/home/plugins/cache/other/thing/0.1.0' }],
        },
        { deadKeys: [], liveKeys: [], unreferenced: [] },
      ],
      [
        'version referenced only by dead records is unreferenced',
        {
          installed: {
            k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: '/dead/a', installPath: '/home/plugins/cache/port/port/0.5.0' }],
            k2: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: '/dead/b', installPath: '/home/plugins/cache/port/port/0.5.0' }],
          },
          cacheDirs: [{ marketplace: 'port', plugin: 'port', version: '0.5.0', path: '/home/plugins/cache/port/port/0.5.0' }],
        },
        { deadKeys: ['k1', 'k2'], liveKeys: [], unreferenced: ['/home/plugins/cache/port/port/0.5.0'] },
      ],
      [
        'version with one live record among dead ones is kept',
        {
          installed: {
            k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: '/dead/a', installPath: '/home/plugins/cache/port/port/0.6.0' }],
            k2: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: '/live/project', installPath: '/home/plugins/cache/port/port/0.6.0' }],
          },
          cacheDirs: [{ marketplace: 'port', plugin: 'port', version: '0.6.0', path: '/home/plugins/cache/port/port/0.6.0' }],
        },
        { deadKeys: ['k1'], liveKeys: ['k2'], unreferenced: [] },
      ],
    ];

    for (const [label, input, expected] of cases) {
      const got = classify({ installed: input.installed, exists, cacheDirs: input.cacheDirs, plugins: ['port@port'] });
      const gotDeadKeys = got.deadRecords.map((r: any) => r.key).sort();
      const gotLiveKeys = got.liveRecords.map((r: any) => r.key).sort();
      expect(
        JSON.stringify(gotDeadKeys) === JSON.stringify([...expected.deadKeys].sort()) &&
          JSON.stringify(gotLiveKeys) === JSON.stringify([...expected.liveKeys].sort()) &&
          JSON.stringify(got.unreferenced.sort()) === JSON.stringify([...expected.unreferenced].sort()),
        'plugin-cache-classifier',
        `classify — ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify({ deadKeys: gotDeadKeys, liveKeys: gotLiveKeys, unreferenced: got.unreferenced })}`,
      );
    }
  }

  // --- classify(): win32 path comparison is case-insensitive -----------------
  {
    const got = classify({
      installed: { k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: '/live', installPath: 'C:\\Users\\x\\plugins\\cache\\port\\port\\0.7.0' }] },
      exists: (p: string) => p === '/live',
      cacheDirs: [{ marketplace: 'port', plugin: 'port', version: '0.7.0', path: 'c:\\users\\x\\plugins\\cache\\port\\port\\0.7.0' }],
      plugins: ['port@port'],
    });
    // Only observable on win32 — a differently-cased fixture off-platform.
    if (process.platform === 'win32') {
      expect(got.unreferenced.length === 0, 'plugin-cache-classifier', `classify — win32 case-insensitive comparison: expected the differently-cased path to match and report nothing unreferenced, got ${JSON.stringify(got.unreferenced)}`);
    } else {
      note('plugin-cache-classifier: win32 case-insensitivity case skipped on this platform');
    }
  }

  // --- assertFenced(): refuses a path outside the scoped cache roots ---------
  {
    const home = process.platform === 'win32' ? 'C:\\Users\\x\\.claude' : '/home/x/.claude';
    const insideFence = join(home, 'plugins', 'cache', 'port', 'port', '1.0.0');
    const outsideFence = join(home, 'some-other-dir');
    expect(assertFenced(insideFence, home, ['port@port']), 'plugin-cache-fence', `assertFenced must accept a path under <home>/plugins/cache/port, got false for ${insideFence}`);
    expect(!assertFenced(outsideFence, home, ['port@port']), 'plugin-cache-fence', `assertFenced must refuse a path outside every scoped marketplace's cache root, got true for ${outsideFence}`);
    expect(!assertFenced(join(home, 'plugins', 'cache', 'other', 'thing', '1.0.0'), home, ['port@port']), 'plugin-cache-fence', 'assertFenced must refuse a path under a marketplace not in the plugins scope');
  }

  // --- End-to-end: report changes nothing, apply removes dead/unreferenced ---
  {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'port-plugin-cache-'));
      const home = join(tmp, 'home');
      const pluginsDir = join(home, 'plugins');
      mkdirSync(pluginsDir, { recursive: true });

      const liveProject = join(tmp, 'live-project');
      mkdirSync(liveProject, { recursive: true });
      const deadProject = join(tmp, 'dead-project'); // created, then removed below
      mkdirSync(deadProject, { recursive: true });
      rmSync(deadProject, { recursive: true, force: true });

      const liveCacheDir = join(pluginsDir, 'cache', 'port', 'port', '0.9.0');
      const deadCacheDir = join(pluginsDir, 'cache', 'port', 'port', '0.8.0');
      const otherVendorDir = join(pluginsDir, 'cache', 'other', 'thing', '1.0.0');
      for (const d of [liveCacheDir, deadCacheDir, otherVendorDir]) mkdirSync(d, { recursive: true });

      const installedPath = join(pluginsDir, 'installed_plugins.json');
      const installedFixture = {
        k1: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: deadProject, installPath: deadCacheDir }],
        k2: [{ marketplaceName: 'port', pluginName: 'port', scope: 'local', projectPath: liveProject, installPath: liveCacheDir }],
        k3: [{ marketplaceName: 'other', pluginName: 'thing', scope: 'local', projectPath: deadProject, installPath: otherVendorDir }],
      };
      writeFileSync(installedPath, JSON.stringify(installedFixture, null, 2));

      const run = (args: string[]) => {
        try {
          return { ok: true, stdout: execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' }) };
        } catch (e: any) {
          return { ok: false, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', status: e.status };
        }
      };

      // report changes nothing on disk.
      const beforeReport = readFileSync(installedPath, 'utf8');
      const reportRes = run(['report', '--home', home, '--json']);
      expect(reportRes.ok, 'plugin-cache-e2e', `report exited non-zero: ${JSON.stringify(reportRes)}`);
      const afterReport = readFileSync(installedPath, 'utf8');
      expect(beforeReport === afterReport, 'plugin-cache-e2e', 'report must never modify installed_plugins.json');
      expect(existsSync(deadCacheDir) && existsSync(liveCacheDir) && existsSync(otherVendorDir), 'plugin-cache-e2e', 'report must never delete a cache directory');

      const reportJson = JSON.parse(reportRes.stdout);
      expect(reportJson.deadRecords.length === 1 && reportJson.deadRecords[0].key === 'k1', 'plugin-cache-e2e', `report --json: expected one dead record (k1), got ${JSON.stringify(reportJson.deadRecords)}`);
      expect(reportJson.unreferenced.length === 1 && reportJson.unreferenced[0] === deadCacheDir, 'plugin-cache-e2e', `report --json: expected deadCacheDir unreferenced, got ${JSON.stringify(reportJson.unreferenced)}`);

      // apply leaves a backup, removes the dead record and unreferenced dir,
      // keeps the live dir and the other vendor's directory untouched.
      const applyRes = run(['apply', '--home', home]);
      expect(applyRes.ok, 'plugin-cache-e2e', `apply exited non-zero: ${JSON.stringify(applyRes)}`);

      const backupMatch = /backup: (.+?)\)/.exec(applyRes.stdout);
      expect(!!backupMatch && existsSync(backupMatch[1]), 'plugin-cache-e2e', `apply must leave a backup file; stdout was ${JSON.stringify(applyRes.stdout)}`);
      if (backupMatch) {
        const backupText = readFileSync(backupMatch[1], 'utf8');
        expect(backupText === beforeReport, 'plugin-cache-e2e', 'backup must be a byte-identical copy of installed_plugins.json before apply');
      }

      const afterApply = JSON.parse(readFileSync(installedPath, 'utf8'));
      expect(!('k1' in afterApply), 'plugin-cache-e2e', 'apply must remove the dead record (k1)');
      expect('k2' in afterApply, 'plugin-cache-e2e', 'apply must keep the live record (k2)');
      expect('k3' in afterApply, 'plugin-cache-e2e', 'apply must keep a non-port-scoped record (k3) untouched');

      expect(!existsSync(deadCacheDir), 'plugin-cache-e2e', 'apply must delete the unreferenced cache directory');
      expect(existsSync(liveCacheDir), 'plugin-cache-e2e', 'apply must keep the cache directory a live record still points at');
      expect(existsSync(otherVendorDir), 'plugin-cache-e2e', 'apply must never touch a directory outside the plugins in scope');

      ok();
    } catch (e) {
      fail('plugin-cache-e2e', `unexpected error: ${message(e)}`);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
}
