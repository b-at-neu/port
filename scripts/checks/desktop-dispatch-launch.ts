import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Split out of desktop-dispatch.ts to stay under the file-size limit: no
// hosted dispatcher session, the onTick pacing, and the quit guard's ordering.
export default function ({ fail, ok }: Reporter) {
  const mainDispatchDir = 'apps/desktop/src/main/dispatch';
  const ipcFile = 'apps/desktop/src/main/ipc.ts';
  const indexFile = 'apps/desktop/src/main/index.ts';
  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const mainDispatchFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainDispatchDir}/`));

  // --- No dispatcher session: no hosted dispatcher role or store.start( ----
  {
    let found = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts') || !rel.startsWith('apps/desktop/src/')) continue;
      const text = readFileSync(f, 'utf8');
      if (/\bkind:\s*'dispatcher'\b|\bDISPATCHER_INSTRUCTIONS\b|\bDISPATCHER_MODEL\b/.test(text)) {
        found = true;
        fail('desktop-dispatch-launch', `${rel} names a dispatcher session role — #326 removed the hosted dispatcher session`);
      }
    }
    for (const f of mainDispatchFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      if (/\bstore\.start\s*\(/.test(readFileSync(f, 'utf8'))) {
        found = true;
        fail('desktop-dispatch-launch', `${rel} calls store.start( — main/dispatch/ never starts a hosted session directly, only through a StageLauncher`);
      }
    }
    if (!found) ok();
  }

  // --- Pacing: onTick: names dispatcher.consider(, onSnapshot: does not -----
  {
    const text = readFileSync(join(root, ipcFile), 'utf8');
    const onTickMatch = /onTick:\s*\([^)]*\)\s*=>\s*\{([^}]*)\}/.exec(text);
    const onSnapshotMatch = /onSnapshot:\s*\([^)]*\)\s*=>\s*\{([^}]*)\}/.exec(text);
    if (!onTickMatch) {
      fail('desktop-dispatch-launch', `${ipcFile} has no 'onTick:' callback — the dispatch loop must be wired to fresh polls only`);
    } else if (!onSnapshotMatch) {
      fail('desktop-dispatch-launch', `${ipcFile} has no 'onSnapshot:' callback to compare against`);
    } else if (!/dispatcher\.consider\(/.test(onTickMatch[1])) {
      fail('desktop-dispatch-launch', `${ipcFile}'s onTick: callback never calls dispatcher.consider( — the loop is not wired to the watcher's clock`);
    } else if (/dispatcher\.consider\(/.test(onSnapshotMatch[1])) {
      fail('desktop-dispatch-launch', `${ipcFile}'s onSnapshot: callback calls dispatcher.consider( — that re-triggers on every republish(), recreating the old feedback loop`);
    } else {
      ok();
    }
  }

  // --- Quit: intercept( precedes shutdownDispatch(, precedes closeAll( -----
  {
    const text = readFileSync(join(root, indexFile), 'utf8');
    const beforeQuitMatch = /before-quit'[\s\S]*?\{([\s\S]*?)\n\s{4}\}\)/.exec(text);
    if (!beforeQuitMatch) {
      fail('desktop-dispatch-launch', `${indexFile} has no 'before-quit' handler body to check`);
    } else {
      const body = beforeQuitMatch[1];
      const interceptIdx = body.indexOf('intercept(');
      const shutdownIdx = body.indexOf('shutdownDispatch?.(');
      const closeAllIdx = body.indexOf('closeAll(');
      if (interceptIdx === -1 || shutdownIdx === -1 || closeAllIdx === -1) {
        fail('desktop-dispatch-launch', `${indexFile}'s before-quit handler is missing intercept(, shutdownDispatch(, or closeAll( — the guard cannot compare an ordering that isn't there`);
      } else if (!(interceptIdx < shutdownIdx && shutdownIdx < closeAllIdx)) {
        fail('desktop-dispatch-launch', `${indexFile}'s before-quit handler calls intercept(/shutdownDispatch(/closeAll( out of order — expected intercept( before shutdownDispatch( before closeAll(`);
      } else {
        ok();
      }
    }
  }
}
