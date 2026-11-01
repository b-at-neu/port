import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// CPU-bound reads stay on the state worker, never creeping back onto the Electron main thread.
export default async function ({ expect }: Reporter) {
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const watcher = read('apps/desktop/src/main/state/watcher.ts');
  const ipc = read('apps/desktop/src/main/ipc.ts');
  const viteConfig = read('apps/desktop/electron.vite.config.mts');

  expect(
    !/from ['"]@\/main\/state\/sources['"]/.test(watcher) && !watcher.includes('projectFromCache'),
    'desktop-offload',
    'watcher.ts imports state/sources or projectFromCache — every source read and the projection go through the StateEngine',
  );
  expect(ipc.includes('createWorkerEngine('), 'desktop-offload', 'ipc.ts never builds the worker engine — the watcher and channels would read on the main thread');
  expect(
    viteConfig.includes('src/main/offload/worker.ts'),
    'desktop-offload',
    'electron.vite.config.mts does not name src/main/offload/worker.ts as a main-build input — state-worker.js would never be emitted',
  );
}
