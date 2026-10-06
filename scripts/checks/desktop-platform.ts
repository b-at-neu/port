import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// apps/desktop/src/main/platform/ is the only place under apps/desktop/src/ that may touch
// a child process, the filesystem, or a path string — a compile-time and layer 1 fact.
export default async function ({ expect, fail, ok }: Reporter) {
  const platformDir = 'apps/desktop/src/main/platform';
  const testingDir = 'apps/desktop/src/testing';
  const runRel = `${platformDir}/run.ts`;
  const srcDir = join(root, 'apps/desktop/src');
  const files = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  // --- child_process is confined to run.ts, and run.ts actually imports it — a shell-out
  // must never creep into an adapter instead of staying behind the platform layer. ---
  {
    let runHasIt = false;
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      if (!text.includes('child_process')) continue;
      if (rel === runRel) {
        runHasIt = true;
        continue;
      }
      fail('desktop-platform-layer', `${rel} references 'child_process' — only ${runRel} may`);
    }
    expect(runHasIt, 'desktop-platform-layer', `${runRel} does not import 'node:child_process' — the guard cannot pass vacuously if the file is deleted`);
  }

  // --- run.ts's node:child_process import binds only execFile/spawn ----------
  {
    const runFile = files.find((f) => relOf(f) === runRel);
    if (!runFile) {
      fail('desktop-platform-layer', `${runRel} does not exist`);
    } else {
      const text = readFileSync(runFile, 'utf8');
      const m = /import\s*\{([^}]*)\}\s*from\s*'node:child_process'/.exec(text);
      if (!m) {
        fail('desktop-platform-layer', `${runRel} has no 'import { ... } from 'node:child_process'' statement`);
      } else {
        const names = m[1].split(',').map((n) => n.trim()).filter((n) => n !== '');
        const allowed = new Set(['execFile', 'spawn']);
        for (const name of names) {
          if (!allowed.has(name)) {
            fail('desktop-platform-layer', `${runRel} imports '${name}' from 'node:child_process' — only execFile/spawn are allowed`);
          }
        }
        ok();
      }
    }
  }

  // --- KNOWN_COMMANDS contains no POSIX-only/shell utility — a non-portable executable
  // would fail only on Windows at runtime. Reads the shared 'nonPortable' classification, never a second inline copy. ---
  {
    const runFile = files.find((f) => relOf(f) === runRel);
    const text = runFile ? readFileSync(runFile, 'utf8') : '';
    const m = /KNOWN_COMMANDS\s*=\s*\[([^\]]*)\]\s*as const/.exec(text);
    if (!m) {
      fail('desktop-platform-layer', `${runRel} has no 'KNOWN_COMMANDS = [...] as const' array`);
    } else {
      const names = [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]);
      const portabilityConfigRel = 'scripts/checks/portability.config.json';
      const denylist = new Set<string>(readJson(portabilityConfigRel).nonPortable ?? []);
      for (const name of names) {
        if (denylist.has(name)) {
          fail('desktop-platform-layer', `${runRel}'s KNOWN_COMMANDS includes '${name}', classified non-portable by ${portabilityConfigRel}`);
        }
      }
      ok();
    }
  }

  // --- No shell:true, no execSync/spawnSync, no *Sync fs call, no stray fs — shelling out
  // or blocking the main process must never regress silently in a future adapter. ---
  {
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');

      if (/shell\s*:\s*true/.test(text)) {
        fail('desktop-platform-layer', `${rel} sets 'shell: true' — every spawn must be shell:false`);
      }

      const fsSyncNames = new Set([
        'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmdirSync', 'rmSync',
        'unlinkSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'renameSync',
        'copyFileSync', 'accessSync', 'realpathSync', 'chmodSync', 'symlinkSync', 'readlinkSync',
      ]);
      for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*Sync)\s*\(/g)) {
        const name = m[1];
        if (name === 'execSync' || name === 'spawnSync') {
          fail('desktop-platform-layer', `${rel} calls a synchronous child_process API ('${name}') — only async execFile is allowed`);
        } else if (fsSyncNames.has(name)) {
          fail('desktop-platform-layer', `${rel} calls '${name}(...)' — no synchronous fs call is allowed under apps/desktop/src/`);
        }
      }

      // A *.test.ts file is exempt — it verifies an adapter's behaviour rather than being
      // one, and needs the real async fs API for a realistic fixture. apps/desktop/src/testing/ is the same exemption; it ships no production code.
      if (
        /from\s*'node:fs(?:\/promises)?'/.test(text) &&
        !rel.startsWith(`${platformDir}/`) &&
        !rel.startsWith(`${testingDir}/`) &&
        !rel.endsWith('.test.ts')
      ) {
        fail('desktop-platform-layer', `${rel} imports 'node:fs' directly — only files under ${platformDir}/, ${testingDir}/, or a *.test.ts fixture may`);
      }
    }
    ok();
  }

  // --- runCommand( is called only from main/platform/ — never a second adapter spawning
  // gh/git itself, or hand-rolling a second failure classifier. ---
  {
    for (const f of files) {
      const rel = relOf(f);
      if (rel.startsWith(`${platformDir}/`)) continue;
      const text = readFileSync(f, 'utf8');
      if (/\brunCommand\s*\(/.test(text)) {
        fail('desktop-platform-layer', `${rel} calls 'runCommand(' directly — only files under ${platformDir}/ may; every other adapter goes through 'gh'/'git'`);
      }
    }
    ok();
  }

  // --- No fs.watch/watchFile/FSWatcher/chokidar anywhere under apps/desktop/src/ — Windows'
  // own deferred last-write-time update means a watch can never be the correctness mechanism. ---
  {
    const forbidden = ['fs.watch', 'watchFile', 'FSWatcher', 'chokidar'];
    let found = false;
    for (const f of files) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const word of forbidden) {
        if (text.includes(word)) {
          found = true;
          fail('desktop-platform-layer', `${rel} references '${word}' — a filesystem watcher is never the follow mechanism, only a poll floor (#84)`);
        }
      }
    }
    if (!found) ok();
  }
}
