import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Checks cross-platform worktree removal: longpaths on every git call, an
// `fs.rmSync` fallback for a `git worktree remove` that half-succeeds
// (deregisters without deleting), an explicit `.claude/worktrees/` orphan
// scan, and a `purge --orphan` mode that replaces worktree-clean's old
// rm -rf/PowerShell recipe (#115). Split out from scripts/checks/worktrees.ts
// (which keeps the pre-existing template/classifier/hygiene assertions) so
// this ticket's new surface gets its own topic module rather than growing
// that one past its own shape.
export default async function ({ fail, ok, note }: Reporter) {
  const scriptPath = join(root, 'plugins/port/bin/worktrees.mjs');
  const { fallbackDecision, classifyRemovalFailure, orphanVerdict, longPathAdvisory, pathKey, stripExtendedPrefix, removeWorktree } =
    await import(pathToFileURL(scriptPath).href);

  // --- Pure cases --------------------------------------------------------------
  // guard(#115): worktree removal decisions drifting — a moved HEAD falling
  // back anyway instead of aborting, or an unreadable `.git` read as an
  // orphan instead of skipped.
  {
    const fdCases: [string, Record<string, unknown>, { action: string; reason?: string }][] = [
      ['dir gone → done', { dirExists: false, stillRegistered: true, headNow: 'a', headClassified: 'a' }, { action: 'done' }],
      ['dir gone, already deregistered too → done', { dirExists: false, stillRegistered: false, headNow: null, headClassified: 'a' }, { action: 'done' }],
      ['dir present, deregistered → fallback (the half-removal case)', { dirExists: true, stillRegistered: false, headNow: null, headClassified: 'a' }, { action: 'fallback' }],
      ['dir present, still registered, HEAD unchanged → fallback', { dirExists: true, stillRegistered: true, headNow: 'a', headClassified: 'a' }, { action: 'fallback' }],
      ['dir present, still registered, HEAD moved → abort', { dirExists: true, stillRegistered: true, headNow: 'b', headClassified: 'a' }, { action: 'abort', reason: 'changed during removal' }],
    ];
    for (const [label, input, expected] of fdCases) {
      const got = fallbackDecision(input);
      if (got.action !== expected.action || (expected.reason !== undefined && got.reason !== expected.reason)) {
        fail('worktrees-removal-pure', `fallbackDecision — ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
      } else {
        ok();
      }
    }

    const crfCases: [string, string][] = [
      ['EBUSY', 'file-in-use'], ['EPERM', 'file-in-use'], ['EACCES', 'file-in-use'], ['ENOTEMPTY', 'file-in-use'],
      ['ENAMETOOLONG', 'long-path'],
      ['EWEIRD', 'unknown'],
    ];
    for (const [code, expected] of crfCases) {
      const got = classifyRemovalFailure(code);
      if (got !== expected) fail('worktrees-removal-pure', `classifyRemovalFailure(${code}): expected ${expected}, got ${got}`);
      else ok();
    }

    const ovCases: [string, Record<string, unknown>, string][] = [
      ['a .git directory is an independent repository, never ours', { gitEntry: 'dir', gitdirTargetExists: false }, 'skip'],
      ['a .git file whose gitdir target exists is still registered', { gitEntry: 'file', gitdirTargetExists: true }, 'skip'],
      ['a .git file whose gitdir target is missing is a stale half-removal', { gitEntry: 'file', gitdirTargetExists: false }, 'orphan'],
      ['an unreadable .git fails toward skip, never deleted on an uncertain fact', { gitEntry: 'unreadable', gitdirTargetExists: false }, 'skip'],
      ['no .git at all is an orphan', { gitEntry: 'none', gitdirTargetExists: false }, 'orphan'],
    ];
    for (const [label, input, expected] of ovCases) {
      const got = orphanVerdict(input);
      if (got !== expected) fail('worktrees-removal-pure', `orphanVerdict — ${label}: expected ${expected}, got ${got}`);
      else ok();
    }

    const lpaCases: [string, Record<string, unknown>, 'advisory' | null][] = [
      ['win32, longpaths unset → advisory', { platform: 'win32', longpaths: null }, 'advisory'],
      ['win32, longpaths already true → none', { platform: 'win32', longpaths: 'true' }, null],
      ["linux, longpaths unset → none (not this platform's problem)", { platform: 'linux', longpaths: null }, null],
    ];
    for (const [label, input, expected] of lpaCases) {
      const got = longPathAdvisory(input);
      const matches = expected === 'advisory' ? typeof got === 'string' && got.length > 0 : got === null;
      if (!matches) fail('worktrees-removal-pure', `longPathAdvisory — ${label}: got ${JSON.stringify(got)}`);
      else ok();
    }

    // pathKey case-folds only on win32 — asserted against this run's own
    // platform rather than faked, since layer 1 itself runs the three-OS
    // matrix (ENGINEERING §6) and each leg exercises its own branch.
    const equalHere = pathKey('/Repo/Path') === pathKey('/repo/path');
    const expectEqual = process.platform === 'win32';
    if (equalHere !== expectEqual) {
      fail('worktrees-removal-pure', `pathKey: expected case-fold=${expectEqual} on ${process.platform}, got ${equalHere}`);
    } else {
      ok();
    }

    // stripExtendedPrefix is pure string manipulation, independent of the
    // host OS, so it is asserted on every platform rather than gated to
    // win32 (#115 R2-C1 — the residual Windows-only pathKey mismatch).
    const sepCases: [string, string, string][] = [
      ['UNC extended prefix', '\\\\?\\UNC\\server\\share\\dir', '\\\\server\\share\\dir'],
      ['local extended prefix', '\\\\?\\C:\\Users\\x\\dir', 'C:\\Users\\x\\dir'],
      ['already plain → no-op', 'C:\\Users\\x\\dir', 'C:\\Users\\x\\dir'],
      ['POSIX path → no-op', '/repo/path', '/repo/path'],
    ];
    for (const [label, input, expected] of sepCases) {
      const got = stripExtendedPrefix(input);
      if (got !== expected) {
        fail('worktrees-removal-pure', `stripExtendedPrefix — ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
      } else {
        ok();
      }
    }
  }

  // --- Injected-failure orchestration -------------------------------------------
  // guard(#115): removeWorktree silently dropping its own fallback call — a
  // variant that skips it fails this block's first case (rmSync would never
  // be called, and removed would read false instead of true).
  {
    const calls: string[] = [];
    const result = removeWorktree('/main', { path: '/main/.claude/worktrees/x', head: 'abc' }, {
      git: (args: string[]) => (args.includes('remove')
        ? { ok: false, stdout: '', stderr: "fatal: unable to unlink 'foo': Invalid argument\n" }
        : { ok: true, stdout: '', stderr: '' }),
      existsSync: () => true,
      rmSync: (p: string) => { calls.push(p); },
      listPorcelain: () => [],
    });
    if (calls.length !== 1 || calls[0] !== '/main/.claude/worktrees/x' || result.removedBy !== 'fallback' || !result.removed || !result.gitError) {
      fail('worktrees-removal-orchestration', `git fails, dir remains: expected one rmSync call on the exact path and removedBy 'fallback', got calls=${JSON.stringify(calls)} result=${JSON.stringify(result)}`);
    } else {
      ok();
    }
  }
  {
    const err = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    const result = removeWorktree('/main', { path: '/x', head: 'abc' }, {
      git: () => ({ ok: false, stdout: '', stderr: 'fatal: boom\n' }),
      existsSync: () => true,
      rmSync: () => { throw err; },
      listPorcelain: () => [],
    });
    if (result.removed !== false || result.cause !== 'file-in-use') {
      fail('worktrees-removal-orchestration', `rmSync EBUSY: expected removed:false, cause:'file-in-use', got ${JSON.stringify(result)}`);
    } else {
      ok();
    }
  }
  {
    let rmCalled = false;
    const result = removeWorktree('/main', { path: '/x', head: 'abc' }, {
      git: () => ({ ok: true, stdout: '', stderr: '' }),
      existsSync: () => false,
      rmSync: () => { rmCalled = true; },
      listPorcelain: () => [],
    });
    if (rmCalled || !result.removed || result.removedBy !== 'git') {
      fail('worktrees-removal-orchestration', `git succeeds, dir gone: expected rmSync never called and removedBy 'git', got rmCalled=${rmCalled} result=${JSON.stringify(result)}`);
    } else {
      ok();
    }
  }
  {
    let rmCalled = false;
    const result = removeWorktree('/main', { path: '/x', head: 'abc' }, {
      git: () => ({ ok: false, stdout: '', stderr: 'fatal: boom\n' }),
      existsSync: () => true,
      rmSync: () => { rmCalled = true; },
      listPorcelain: () => [{ path: '/x', head: 'def' }],
    });
    if (rmCalled || result.removed !== false || result.cause !== null) {
      fail('worktrees-removal-orchestration', `HEAD moved: expected rmSync never called and removed:false, cause:null, got rmCalled=${rmCalled} result=${JSON.stringify(result)}`);
    } else {
      ok();
    }
  }

  // --- Real-git end-to-end fixture ----------------------------------------------
  // guard(#115): a worktree with a long-path, read-only, or junctioned
  // dependency tree surviving reclaim on Windows, or removal following a
  // junction out of the worktree.
  {
    const fixture = mkdtempSync(join(tmpdir(), 'port-worktrees-removal-'));
    const storeDir = mkdtempSync(join(tmpdir(), 'port-worktrees-removal-store-'));
    const sentinel = join(storeDir, 'sentinel.txt');
    const emptyConfigPath = join(storeDir, 'empty.gitconfig');
    writeFileSync(sentinel, 'sentinel');
    writeFileSync(emptyConfigPath, '');

    // Runner-level `core.longpaths` (or any machine config) must not mask
    // this script's own route: an isolated env with no system/global config.
    const fixtureEnv = () => {
      const e = { ...process.env };
      delete e.GIT_DIR;
      delete e.GIT_WORK_TREE;
      delete e.GIT_INDEX_FILE;
      e.GIT_CONFIG_NOSYSTEM = '1';
      e.GIT_CONFIG_GLOBAL = emptyConfigPath;
      return e;
    };
    const runGit = (args: string[], cwd: string) => spawnSync('git', args, { cwd, env: fixtureEnv(), encoding: 'utf8' });
    const must = (res: ReturnType<typeof runGit>, step: string) => {
      if (res.status !== 0) throw new Error(`${step} failed: ${res.stderr || res.stdout}`);
    };

    try {
      must(runGit(['init', '-b', 'dev'], fixture), 'git init');
      writeFileSync(join(fixture, '.gitignore'), 'node_modules/\n');
      must(runGit(['add', '.gitignore'], fixture), 'git add .gitignore');
      must(runGit(['-c', 'user.name=Port Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'chore: fixture init'], fixture), 'git commit');

      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'port.config.json'), JSON.stringify({ repo: 'example/fixture', branches: { integration: 'dev' } }));

      must(runGit(['worktree', 'add', '--detach', '.claude/worktrees/agent-fixture', 'dev'], fixture), 'git worktree add');

      const wt = join(fixture, '.claude', 'worktrees', 'agent-fixture');
      const nm = join(wt, 'node_modules');
      mkdirSync(nm, { recursive: true });

      // A nested path whose absolute length exceeds 300 characters.
      let deep = nm;
      const segment = 'x'.repeat(40);
      while (deep.length < 310) deep = join(deep, segment);
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'f.txt'), 'deep');

      // A read-only file.
      const roFile = join(nm, 'readonly.txt');
      writeFileSync(roFile, 'ro');
      chmodSync(roFile, 0o444);

      // A junction pointing outside the worktree, at a sibling directory
      // holding the sentinel — removal must never traverse through it.
      symlinkSync(storeDir, join(nm, 'linked'), 'junction');

      // An untracked directory with no `.git` at all, beside the registered
      // worktree — nothing correlates it, so it must surface as an orphan.
      const orphanDir = join(fixture, '.claude', 'worktrees', 'orphan-fixture');
      mkdirSync(join(orphanDir, 'node_modules'), { recursive: true });

      const reclaimRes = spawnSync(process.execPath, [scriptPath, 'reclaim', '--offline', '--json'], { cwd: fixture, env: fixtureEnv(), encoding: 'utf8' });
      let parsed: any = null;
      try {
        parsed = JSON.parse(reclaimRes.stdout);
      } catch {
        fail('worktrees-removal-e2e', `reclaim --offline --json produced unparseable output (exit ${reclaimRes.status}): ${reclaimRes.stdout || reclaimRes.stderr}`);
      }

      if (parsed) {
        const candidate = (parsed.candidates ?? []).find((c: any) => c.path === wt || String(c.path).endsWith('agent-fixture'));
        if (!candidate?.removed) fail('worktrees-removal-e2e', `expected the fixture worktree removed, got ${JSON.stringify(candidate)}`);
        else ok();

        if (existsSync(wt)) fail('worktrees-removal-e2e', `expected ${wt} to be gone after reclaim, it still exists`);
        else ok();

        const remaining = (runGit(['worktree', 'list', '--porcelain'], fixture).stdout.match(/^worktree /gm) ?? []).length;
        if (remaining !== 1) fail('worktrees-removal-e2e', `expected only the main worktree registered after reclaim, got ${remaining}`);
        else ok();

        if (!existsSync(sentinel)) fail('worktrees-removal-e2e', "the junction target's sentinel file was deleted — removal followed the junction out of the worktree");
        else ok();

        if (!(parsed.orphanDirs ?? []).some((p: string) => p.endsWith('orphan-fixture'))) {
          fail('worktrees-removal-e2e', `expected orphanDirs to include orphan-fixture even with nothing registered there any more, got ${JSON.stringify(parsed.orphanDirs)}`);
        } else {
          ok();
        }

        const advisoriesOk = process.platform === 'win32' ? (parsed.advisories ?? []).length > 0 : (parsed.advisories ?? []).length === 0;
        if (!advisoriesOk) fail('worktrees-removal-e2e', `advisories: expected ${process.platform === 'win32' ? 'non-empty' : 'empty'} on ${process.platform}, got ${JSON.stringify(parsed.advisories)}`);
        else ok();

        // The root-cause evidence this ticket exists to produce: which route
        // actually recovered the fixture, on whichever OS this leg is.
        if (candidate) note(`worktrees-removal e2e (${process.platform}): fixture removed via ${candidate.removedBy}${candidate.gitError ? ` (git: ${candidate.gitError})` : ''}`);
      }

      // Purge: a real, but non-orphan, path is refused.
      const refusedRes = spawnSync(process.execPath, [scriptPath, 'purge', '--orphan', join(fixture, '.claude')], { cwd: fixture, env: fixtureEnv(), encoding: 'utf8' });
      if (refusedRes.status !== 2 || !existsSync(join(fixture, '.claude'))) {
        fail('worktrees-removal-e2e', `purge on a non-orphan path: expected exit 2 and the path left intact, got exit ${refusedRes.status}, exists=${existsSync(join(fixture, '.claude'))}`);
      } else {
        ok();
      }

      // Purge: the actual orphan is deleted.
      const purgeRes = spawnSync(process.execPath, [scriptPath, 'purge', '--orphan', orphanDir], { cwd: fixture, env: fixtureEnv(), encoding: 'utf8' });
      if (purgeRes.status !== 0 || existsSync(orphanDir)) {
        fail('worktrees-removal-e2e', `purge on the actual orphan: expected exit 0 and the directory gone, got exit ${purgeRes.status}, exists=${existsSync(orphanDir)}`);
      } else {
        ok();
      }
    } catch (e: any) {
      fail('worktrees-removal-e2e', `fixture setup or assertion threw: ${e.message}`);
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
      rmSync(storeDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // --- Skill guard: worktree-clean no longer reverts to POSIX/PowerShell-only deletion ----
  // guard(#115): the manual escape hatch reverting to POSIX/PowerShell-only
  // deletion instead of the script's own cross-platform `purge` mode.
  {
    const rel = 'plugins/port/skills/worktree-clean/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');
    const forbidden = [/\brm -rf\b/, /\bpowershell\b/i, /\bcmd\s+\/\/c\b/, /\bdu -sh\b/];
    const hit = forbidden.find((re) => re.test(text));
    if (hit) {
      fail('worktree-clean-skill-guard', `${rel} still names ${hit} — the manual escape hatch must drive 'purge --orphan', never a POSIX/PowerShell-only recipe`);
    } else {
      ok();
    }
    if (!text.includes('purge --orphan')) {
      fail('worktree-clean-skill-guard', `${rel} never names 'purge --orphan' — the script's own deletion route`);
    } else {
      ok();
    }
  }

  note('worktrees-removal: pure cases, injected-failure orchestration, a real-git end-to-end fixture, and the worktree-clean skill guard');
}
