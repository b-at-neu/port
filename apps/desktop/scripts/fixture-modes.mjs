// Which electron-vite build modes carry fixture data. Imports only `node:` builtins (none today) so
// `scripts/checks/desktop-packaging.ts` (layer 1) can import this module with no `node_modules`.

/** The only modes that resolve `#app-fixtures` to the real fixtures; every other mode, `production` included, gets none. */
export const FIXTURE_BUILD_MODES = ['development', 'fixtures', 'smoke']

/** `compiled`: the build carries fixture data. `packaged`: a packaged app of this build still honours `PORT_FIXTURES` (the `smoke` copy only). */
export function fixtureBuild(mode) {
  return { compiled: FIXTURE_BUILD_MODES.includes(mode), packaged: mode === 'smoke' }
}
