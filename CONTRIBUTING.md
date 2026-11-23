# Contributing

## Working on the plugin

Repository map and the ship boundary: [ARCHITECTURE.md](ARCHITECTURE.md).

This repository is both a plugin marketplace and the plugin it distributes. `README.md`'s install command — `claude plugin marketplace add b-at-neu/port@main --scope project` — is the **consumer** path: it is what a managed repository commits so the pipeline travels with the checkout. It is wrong here, because this repository's own committed `.claude/settings.json` already carries a **project**-scope `port` marketplace entry, and a plain `marketplace add` with no `--scope` writes **user** scope — which project scope silently outranks. Following the README's instructions unscoped in this repository looks like it worked and changes nothing this repository loads — though it still repoints the `port` name for the whole machine (below).

The only scope that outranks the committed project-scope entry is **`local`** — gitignored, machine-specific, and exactly what a local-directory dev loop needs. Run all three commands from the **main checkout**:

```bash
claude plugin marketplace add /absolute/path/to/port/plugins --scope local
claude plugin install port@port-dev --scope local
claude plugin disable port@port --scope local
```

The dev-loop marketplace manifest lives at `plugins/.claude-plugin/marketplace.json`, named **`port-dev`** — a distinct name from the `port` marketplace every consumer's committed `ref` (`main`, or a release tag) resolves against — and it names this checkout's `./port` as its one plugin's source. It is why the recipe installs from `/absolute/path/to/port/plugins`, not the repository root.

This is **local** scope, not user scope, deliberately: at user scope, `port@port-dev` would be enabled in every repository on the machine, next to each consumer's own project-scope `port@port` — two copies of `port` loading there at once. Local scope stays confined to this checkout, and only local scope outranks the committed project-scope `port@port` enable — a user-scope `disable` could not turn that project-scope enable off.

The third line is what makes exactly one `port` load here: `claude plugin disable port@port --scope local` outranks the committed project-scope enable, locally, so the dev-loop install is the only one this checkout ever loads. Without it, both `port@port` (the committed entry) and `port@port-dev` (the local install) would load side by side.

This writes to `.claude/settings.local.json`, already covered by this repository's `.gitignore`.

**One-time migration**, for a machine still set up with the old shared-name recipe (`port@port` installed at user or local scope from a directory source): remove any `extraKnownMarketplaces.port` entry whose `source` is a `directory`, and its matching `enabledPlugins` key, from `~/.claude/settings.json` and `.claude/settings.local.json`. Then, in a consumer repository, re-run README step 1's `marketplace add` line and `/port:init`, choosing **Reconcile**. The tell stays the same: that consumer's cockpit line reports `staleness not computable` for a directory source outside its working tree.

**Because `port-dev` is a name no consumer resolves, this checkout's own dev loop never repoints what any other repository loads.** There is one live source per marketplace name — the most recent `claude plugin marketplace add` for a name wins, at any scope, for every repository on the machine that resolves it — but `port-dev` is a name a consumer's committed pin never names, so adding it here repoints nothing else. The `port` marketplace name stays whatever source a consumer's own `marketplace add` or `/port:init` last gave it — this repository's dev loop no longer touches that slot at all.

Edits under `plugins/port/` take effect immediately — there is no build step and nothing to invalidate. A session that is already running has loaded its components, so run `/reload-plugins` there to pick up changes. **A cache path is not evidence of a stale copy** — a directory-sourced plugin is *copied* into `~/.claude/plugins/cache/` at install time, so a local-scope install from this checkout lands at exactly the same kind of cache path a GitHub-sourced one does; the old tell reported "stale" every time under a directory source, including when the override worked perfectly. **The replacement tell is the cockpit's own startup line** (see "Running plugin identity" in `pipeline/SKILL.md`), which resolves and prints the applicable install record's short commit sha and scope — that sha should equal `git rev-parse --short HEAD` in this checkout once the local-scope override is running. If it does not, the override has not taken yet — reinstall and start a new session.

**The ground-truth test is three-way, not `diff -rq` alone.** Measured 2026-08-31: `diff -rq` returned silence while both the cache and this checkout sat 42 commits behind `origin/dev`, so three days of merged fixes were absent and the documented verification reported no problem — a check that cannot distinguish the state it exists to detect. Both halves are required, because either alone passes while the running plugin is stale:

```bash
git rev-list --count HEAD..origin/dev                                               # must be 0 — this checkout is current
diff -rq ~/.claude/plugins/cache/port-dev/port/<version> plugins/port              # must be silent — the cache matches this checkout
```

`<version>` is `plugins/port/.claude-plugin/plugin.json`'s own `version` field — read it there rather than typing a literal, which would read wrong the moment this repository releases again.

`git rev-list --count` alone misses uncommitted working-tree edits — under a directory source those are absent from the cache while the count still reads `0`. `diff -rq` alone misses this checkout itself being behind the remote, which is exactly what the 42-commit case above measured.

### The integration branch stays on a prerelease version

`dev`'s `plugins/port/.claude-plugin/plugin.json` carries a prerelease-suffixed version (`<X.Y.Z>-dev`) at rest, never a clean `<X.Y.Z>`. The cache directory is keyed by marketplace, plugin, **and** version, and `port-dev` already gives the dev loop its own marketplace segment (`cache/port-dev/port/<version>/`), separate from a consumer's `cache/port/port/<version>/` — so the marketplace name alone is what now keeps a dev-loop install and a consumer's released install from ever resolving to the same cache directory. The suffix is a second, independent reason to keep a clean version off `dev`: a cache path with no suffix (`cache/port-dev/port/<version>/`) reads identically whether the version underneath it is actually released or still in flight, where the `-dev` suffix is readable at a glance as "not that release" even before anything reads the commit it was installed from.

`/port:release`'s bump pull request strips the suffix as part of the bump it already performs, and `release.postPublishHook` → `scripts/dev-window.ts` restores it immediately after publishing, by opening a `devwindow/v<next>` pull request against `dev`. **Merge that pull request before doing anything else with the dev loop** — between the bump merging and the dev-window pull request merging, `dev` does carry a releasable version. The corridor caveat now only matters for an install made from this checkout under the root manifest's own `port` name — the ordinary `port@port-dev` dev loop keeps its own marketplace segment regardless, so it never collides with a consumer's `cache/port/port/<version>/` either way.

That window is the release corridor (#224), and it is entirely legitimate while a release is actually in flight — `run-release-corridor` (`scripts/release-corridor.ts`, on push to `dev`/`main`) is what tells that apart from a corridor left open with nothing addressing it, since only a live GitHub read can. It passes while an open `Release v<version>` pull request, an unpublished merged bump, or an open dev-window pull request explains the clean version, and fails only when none of those do. Layer 1 (`node scripts/checks.ts`) cannot see GitHub, so it only notes a clean integration branch rather than guessing; `node scripts/release-corridor.ts` answers the same question from any checkout.

### Never install from inside a managed worktree

Every install scope — `user`, `project`, `local` — resolves to the **same** `installPath` on disk. An install performed from inside `.claude/worktrees/<anything>` (a dispatched agent's own worktree, or an `/port:implement` operator worktree) silently repoints what **every** session on this machine loads, worktree or not, and keeps doing so after that worktree is gone — the failure is silent and survives the worktree's deletion. The guard hook denies `claude plugin install`/`uninstall`/`marketplace add`/`marketplace remove` from any cwd under `.claude/worktrees/`, for any caller, with no exemption for an `/port:implement` session (see `docs/PIPELINE.md` → "Why background dispatch needs care"). Always install and reinstall from the main checkout.

A `local`/`project`-scope install record is keyed by its `projectPath`, so deleting that directory — a reclaimed worktree, a removed clone, a repository moved elsewhere — never removes the record, and `claude plugin uninstall --scope local` cannot run from a directory that no longer exists. The record goes on pinning its cache version forever, and the documented 14-day sweep never catches it, since no orphan marker is ever written for an install whose continuity broke this way. Run `/port:plugin-cache-clean` after reclaiming worktrees, or after moving or deleting any checkout that ran the dev loop, to clear what accumulated — it is machine-wide, so one run after this checkout's own worktrees are gone also covers every other project's stale records.

### The three gates on a GitHub-sourced install

An install from a `github` marketplace source — the consumer path, and this repository's own committed entry — advances only when all three of these line up. Any one wrong, and the running copy silently never changes:

- **`version`** in `plugins/port/.claude-plugin/plugin.json` — the release signal. The plugin's on-disk cache directory is keyed by marketplace, plugin, **and** this version string (`~/.claude/plugins/cache/port/port/<version>/`), so `claude plugin marketplace update port` refreshes the marketplace's own clone but **cannot advance a pinned install** whose version has not moved.
- **`ref`** — defaults to the marketplace repository's *default* branch when unset, which tracks whatever merges there rather than a release. `/port:init` pins a consumer's `ref` to `b-at-neu/port`'s newest published release tag (`v<semver>`), or `main` — this repository's release branch — if none has shipped yet; either is a deliberate pin, but an immutable tag never advances on its own, so a consumer moves forward only by re-running `/port:init` and choosing **Reconcile**. This repository's own committed entry stays pinned to `main` for now, as the contributor-facing form (see above).
- **`autoUpdate`** — off by default for third-party marketplaces, so even a real version bump sits unfetched until this is `true` or someone updates manually.

One line covers all three: **publishing a release tag is what reaches a pinned consumer — merging the release pull request into `main` alone does not, since an immutable tag pin never moves on its own.** `/port:release` is what lands that merge and cuts the tag.

### Refreshing a GitHub-sourced install by hand

`git pull` does nothing for it — the loader never reads this working tree, only the fetched marketplace clone and the versioned cache. `/reload-plugins` does nothing either — the bytes already on disk are unchanged; there is nothing for it to reload. Under a tag pin, this recipe re-fetches the **same** tag `ref` already names, so it does not move a pinned consumer forward on its own — moving forward means changing `ref` first, which is what re-running `/port:init` and choosing **Reconcile** does. To force a GitHub-sourced install to catch up to a real version bump:

```bash
claude plugin marketplace update port
claude plugin uninstall port@port --scope project
claude plugin install port@port --scope project
```

Then start a **new** session — an update never applies mid-session.

## Checking that a change parsed

```bash
claude plugin details port@port-dev
```

This prints the component inventory. **A skill that fails to parse is silently absent from it rather than reported as an error** — so check that the counts went up, rather than looking for a complaint. It confirms the component parsed, not that the running session has it — that is confirmed only by invoking it. It reads `port-dev`'s own live source, which always names this checkout's `./port` — so, unlike the old shared-name recipe, it reflects this checkout regardless of what any consumer repository's own `port` marketplace currently points at.

After editing `plugins/.claude-plugin/marketplace.json` or `plugin.json`, re-validate them:

```bash
claude plugin marketplace update port-dev
```

## Testing a change

Three layers, separated by cost: static file checks, artifact assertions on real pipeline runs, and behavioural evals. What to run and when is in [docs/TESTING.md](docs/TESTING.md).

## Working on scripts/

`scripts/` is TypeScript, but Node's own type stripping runs it directly — no build step, no install, and no `typescript` dependency for a dispatched agent's worktree. That needs **Node ≥22.18.0**, a genuine compatibility floor, not an example: below that floor, `node scripts/checks.ts` fails with a parse error before any of the file's own code runs, so the symptom will not name the cause. `package.json`'s `engines.node` is the source of the floor, and layer 1 pins the two together. CI's `setup-node` major resolves above it.

Type stripping is not type checking — it erases annotations, it does not verify them. `scripts/` is never type-checked at runtime, only at load; run `pnpm typecheck:scripts` yourself before pushing if you touched a `.ts` file there; CI's `run-scripts-typecheck` job runs it on every pull request regardless. `pnpm install` is needed only for that (and for `apps/desktop`), never for running the scripts themselves.

## Writing hooks

Once installed at user scope the plugin loads in every session, whatever the working directory. A hook must therefore return immediately when the repository has no `.claude/port.config.json` — without that guard, installing this plugin changes behaviour in every unrelated project on the machine.

A hook records a harness decision; it never re-derives one. Re-implementing permission matching (or any other engine the harness already runs) as a second copy inside a hook drifts from the original and reports what the hook *predicts* happened rather than what actually did — the failure #63 fixed.

## Commit messages

Subject: `#<issue> <imperative lowercase summary>`, under 80 characters, no trailing period. Use `#0` when a commit genuinely has no issue.

Write the message to a file and `git commit -F <file>` rather than using inline `-m`, which collapses on Windows and drops the subject and co-authorship.

## Engineering standards

[docs/ENGINEERING.md](docs/ENGINEERING.md) is this repository's standards document, and `docs.engineering` points at it — so all four stage agents read it before working and `review-agent` cites it as a review dimension. The plugin and `scripts/` rules (§1–§8) record existing practice, cited to the file each was inferred from; §9's desktop rules are the target the app is migrated to.

Read §8, the pre-pull-request self-check, before opening one. The short version, unchanged from what this section said before the document existed: small focused files, no dead scaffolding or transitional shims, comments rare and one line, never citing a ticket, and no placeholder content committed in anticipation of a later ticket.

It is deliberately **not** shipped — it is this repository's own bar, not the plugin's. `plugins/port/templates/ENGINEERING.template.md` is the skeleton `/port:init` installs into an adopting repository, alongside `plugins/port/templates/DESIGN.template.md` for a repository with a real interface, and `/port:analyze` is what fills either in from a codebase.

## Working on the desktop app

`apps/desktop` is a pnpm workspace member — an Electron + TypeScript app built with electron-vite. The root is a two-level pnpm workspace (`pnpm-workspace.yaml` lists `apps/*`); running `pnpm install` at the repository root links the shared, content-addressable pnpm store into every member, so a fresh worktree checkout never re-downloads packages it already has cached.

Common commands, run from the repository root:

```bash
pnpm install                          # bootstrap the workspace
pnpm --filter @port/desktop dev       # launch the app
pnpm typecheck                        # both tsconfigs, across all members
pnpm lint
pnpm test
pnpm build                            # produces apps/desktop/out/{main,preload,renderer}
```

Installers: `apps/desktop/README.md` → Building installers.

Packaged smoke test (#336): after `pnpm --filter @port/desktop dist`, run `pnpm --filter @port/desktop smoke:packaged` — it launches the release executable in `dist/` (never the dev build) with fixtures off, and checks the app launches, mounts, hits no page or console error, and quits cleanly. It then runs the visual capture against a **separate** fixture-enabled copy, built with `pnpm --filter @port/desktop dist:smoke` (`electron-vite build --mode smoke`, which alone compiles `PORT_FIXTURES` to work even packaged) into `dist/smoke/` — the only packaged build that bundles `apps/desktop/tests/fixtures/app/`, writing screenshots to `out/screenshots-packaged/` rather than `out/screenshots/`. Both specs run under one Playwright config (`playwright.packaged.config.mts`), reusing the visual harness's xvfb-aware runner (`scripts/screenshots.mjs`), so neither ever runs alongside `pnpm screenshots`'s own spec. The release build itself never carries fixtures, and `pnpm --filter @port/desktop dist` fails if its asar's main-process JS does.

A cross-folder import inside `apps/desktop/src` uses the `@/` alias, rooted at `src` (`@/main/…`, `@/preload/…`, `@/renderer/…`, `@/types/…`, `@/utils/…`) — a `./` sibling import is fine, but a `../` parent import that stays inside `src` is a `port/no-parent-import` error. `node apps/desktop/scripts/alias-imports.mjs [--check] <dir>…` (run from `apps/desktop`) rewrites a directory's relative imports to the alias; `--check` reports without writing.

The desktop app's patterns, test policy and checks policy are in [docs/ENGINEERING.md](docs/ENGINEERING.md) §9. Adding a call is one action file plus its renderer call site.

The label vocabulary the app resolves lives in `apps/desktop/src/utils/labels/`, holds two vocabularies, each bundled at build time and pinned byte-identical to its shipped file under `plugins/port/data/`. `labels.legacy.json` (imported by `defaults.ts`) is the frozen 17 stage keys the app decides by, pinned by `desktop-label-copy`. `labels.json` (imported by `display.ts`) is the seven labels the app shows and `/port:init` writes, pinned by `labels-display-copy`. Adding a stage key means editing the legacy pair plus `vocabulary.ts`'s `LABEL_KEYS`, and adding a display label means editing the display pair plus `display.ts`'s `DISPLAY_KEYS` (pinned by `display.test.ts`) and the schema's `labels` or `states`, or `desktop-label-copy`, `desktop-label-defaults` or the `labels-display` checks in layer 1 fail (`docs/TESTING.md` → "Layer 1 — static checks").

These commands run in CI (`run-app-checks` in `.github/workflows/checks.yml`) on all three platforms, and are deliberately absent from `commands.checks` in `.claude/port.config.json`, which stays dependency-free — see `docs/TESTING.md` → "Layer 1 — static checks".

Whether this app may write a pipeline label at all is scoped, not assumed: it writes no label without a claim in scope, and [docs/COORDINATION.md](docs/COORDINATION.md) is the contract — who owns which write, the claim file's shape, and how a conflict is detected and presented.

**The React renderer (#316).** React, Tailwind v4, shadcn/ui and TanStack Query/Router are bundled renderer `devDependencies`, never `dependencies` — Vite bundles all of them into `out/renderer`, so nothing here is a runtime install the operator's machine needs; `dependencies` stays the main process's own externalized set (`ajv`, the Agent SDK). React mounts into `#react-root`, beside the legacy, hand-built DOM screens `main.ts` still owns — a screen is migrated one at a time, never all at once, and until it is, work inside it matches the surrounding legacy code (`docs/DESIGN.md`'s own "Status" note). Every colour value lives in `apps/desktop/src/renderer/styles/theme.css` alone, as CSS custom properties on shadcn's own role names — a component reaches a colour only through a Tailwind utility backed by one of those roles, never a hex literal or an arbitrary value, which `eslint/no-raw-colour.mjs`'s local `port/no-raw-colour` rule enforces in source and `scripts/checks/desktop-safety.ts` enforces in stylesheets.

Add a shadcn component only through its own CLI (`pnpm dlx shadcn@latest add <component>`, run from `apps/desktop`), never hand-authored from scratch — it writes real source into `src/renderer/components/ui/`, so the component's code is always in the tree to read and change, not hidden inside a package. The CLI's own generated colour variables get moved into `theme.css` and set to the `docs/DESIGN.md` §1 values immediately after generation; change a shipped primitive only through a variant, never by editing its markup, and reach for a shared `components/` piece before writing a one-off a second screen would have to duplicate.

The `useEffect`/`useLayoutEffect` ban in `src/renderer/**/*.{ts,tsx}` is total, enforced by ESLint (`no-restricted-imports`/`no-restricted-properties`), which holds only where `pnpm install` ran, as it always does in CI — data fetching and synchronization go through TanStack Query (`renderer/data/`) or `useSyncExternalStore` (`renderer/theme/store.ts`'s own `useThemePreference`), never a mount-time side effect.

**The visual check harness (#317).** `pnpm screenshots`, run from the repository root, builds the app with `--mode fixtures` and then drives it with Playwright's experimental Electron support: one spec (`apps/desktop/tests/visual/screens.spec.mts`) screenshots every React route in light and dark, from canned data, into `apps/desktop/out/screenshots/` — no `gh` or `claude` call anywhere in the run. `apps/desktop/tests/fixtures/app/` is what makes that possible — only `pnpm dev`, `--mode fixtures` and `--mode smoke` builds bundle it, so `pnpm build` and the release build carry none, and a `PORT_FIXTURES=1` launch of one exits 1 instead of opening the real app: `PORT_FIXTURES=1` (plus an absolute `PORT_FIXTURES_USER_DATA`, so a fixture run never touches the operator's own profile or single-instance lock) puts the main process in fixture mode, registering a canned handler for every IPC channel instead of the real adapter chain. The board snapshot is not hand-typed data, though — fixture reads pass through the same `reconcileRepository`/`planTick` the real app uses, so a screenshot shows what the real derivation produces, not a mock of it. Run it by hand the same way: `PORT_FIXTURES=1 PORT_FIXTURES_USER_DATA=/tmp/port-fixtures pnpm --filter @port/desktop dev`, adding `PORT_FIXTURES_SCENARIO=<name>` (`populated` by default, `empty`, `unregistered`, `failing`, `registry-error`, `update-available`, `update-downloading`, `update-download-failed` or `attention`) to drive one scenario. `populated` is a healthy pipeline; `attention` carries every needs-you and problem state. A new empty or error capture goes in `VARIANT_TARGETS` under the scenario that produces it, and a needs-you or problem capture goes under `attention`. To put captures in a pull request, `node plugins/port/bin/artifacts.mjs screenshots <manifest.json> --issue N --out <file.md>` commits them to the never-merged `port-screenshots` branch and writes the `## Screenshots` markdown block.

What a screenshot run does to your desktop depends on the OS (`apps/desktop/scripts/screenshots.mjs` decides, through `display.mjs`). A fixture launch shows its window without taking focus on every platform:

- **Linux with Xvfb:** the runner wraps Playwright in `xvfb-run`, so nothing appears. Xvfb is recommended.
- **Linux without Xvfb:** a background window appears with no focus and stays until the run finishes, and the runner prints how to install Xvfb. With no `DISPLAY`/`WAYLAND_DISPLAY` either, the command refuses with the exact `apt install` line rather than hanging.
- **macOS:** a background window appears with no focus, no app activation, and no Dock icon.
- **Windows:** a background window appears with no focus; its taskbar button still appears.

The same applies to `smoke:packaged`'s visual capture and to `pnpm --filter @port/desktop e2e`; the plain packaged smoke spec (fixtures off) deliberately launches normally. A new React route needs a capture (or, for a screen `main.ts` still hand-draws, a stated skip) target in `apps/desktop/tests/visual/targets.mts` — the table is exhaustive over the router's own `ROUTE_IDS`, so a route left unclassified fails `pnpm typecheck`. Adding a fixture for a new IPC channel is the same shape: `apps/desktop/tests/fixtures/app/handlers.ts`'s `FixtureHandlers` type is exhaustive over `IpcChannel`, so a channel with no canned answer fails `pnpm typecheck` there too.