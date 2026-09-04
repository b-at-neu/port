# Contributing

## Working on the plugin

This repository is both a plugin marketplace and the plugin it distributes. `README.md`'s install command — `claude plugin marketplace add b-at-neu/port@main --scope project` — is the **consumer** path: it is what a managed repository commits so the pipeline travels with the checkout. It is wrong here, because this repository's own committed `.claude/settings.json` already carries a **project**-scope `port` marketplace entry, and a plain `marketplace add` with no `--scope` writes **user** scope — which project scope silently outranks. Following the README's instructions unscoped in this repository looks like it worked and changes nothing.

The only scope that outranks the committed project-scope entry is **`local`** — gitignored, machine-specific, and exactly what a local-directory dev loop needs:

```bash
claude plugin marketplace add /absolute/path/to/port --scope local
claude plugin install port@port --scope local
```

This writes to `.claude/settings.local.json`, already covered by this repository's `.gitignore`.

Edits under `plugins/port/` take effect immediately — there is no build step and nothing to invalidate. A session that is already running has loaded its components, so run `/reload-plugins` there to pick up changes. **A cache path is not evidence of a stale copy** — a directory-sourced plugin is *copied* into `~/.claude/plugins/cache/` at install time, so a local-scope install from this checkout lands at exactly the same kind of cache path a GitHub-sourced one does; the old tell reported "stale" every time under a directory source, including when the override worked perfectly. **The replacement tell is the cockpit's own startup line** (see "Running plugin identity" in `pipeline/SKILL.md`), which resolves and prints the applicable install record's short commit sha and scope — that sha should equal `git rev-parse --short HEAD` in this checkout once the local-scope override is running. If it does not, the override has not taken yet — reinstall and start a new session.

**The ground-truth test is three-way, not `diff -rq` alone.** Measured 2026-08-31: `diff -rq` returned silence while both the cache and this checkout sat 42 commits behind `origin/dev`, so three days of merged fixes were absent and the documented verification reported no problem — a check that cannot distinguish the state it exists to detect. Both halves are required, because either alone passes while the running plugin is stale:

```bash
git rev-list --count HEAD..origin/dev                                   # must be 0 — this checkout is current
diff -rq ~/.claude/plugins/cache/port/port/0.1.0 plugins/port           # must be silent — the cache matches this checkout
```

`git rev-list --count` alone misses uncommitted working-tree edits — under a directory source those are absent from the cache while the count still reads `0`. `diff -rq` alone misses this checkout itself being behind the remote, which is exactly what the 42-commit case above measured.

### Never install from inside a managed worktree

Every install scope — `user`, `project`, `local` — resolves to the **same** `installPath` on disk. An install performed from inside `.claude/worktrees/<anything>` (a dispatched agent's own worktree, or an `/port:implement` operator worktree) silently repoints what **every** session on this machine loads, worktree or not, and keeps doing so after that worktree is gone — the failure is silent and survives the worktree's deletion. The guard hook denies `claude plugin install`/`uninstall`/`marketplace add`/`marketplace remove` from any cwd under `.claude/worktrees/`, for any caller, with no exemption for an `/port:implement` session (see `docs/PIPELINE.md` → "Why background dispatch needs care"). Always install and reinstall from the main checkout.

### The three gates on a GitHub-sourced install

An install from a `github` marketplace source — the consumer path, and this repository's own committed entry — advances only when all three of these line up. Any one wrong, and the running copy silently never changes:

- **`version`** in `plugins/port/.claude-plugin/plugin.json` — the release signal. The plugin's on-disk cache directory is keyed by this string (`~/.claude/plugins/cache/port/port/<version>/`), so `claude plugin marketplace update port` refreshes the marketplace's own clone but **cannot advance a pinned install** whose version has not moved.
- **`ref`** — defaults to the marketplace repository's *default* branch when unset, which tracks whatever merges there rather than a release. `/port:init` pins a consumer's `ref` to `b-at-neu/port`'s newest published release tag (`v<semver>`), or `main` — this repository's release branch — if none has shipped yet; either is a deliberate pin, but an immutable tag never advances on its own, so a consumer moves forward only by re-running `/port:init`. This repository's own committed entry stays pinned to `main` for now, as the contributor-facing form (see above).
- **`autoUpdate`** — off by default for third-party marketplaces, so even a real version bump sits unfetched until this is `true` or someone updates manually.

One line covers all three: **publishing a release tag is what reaches a pinned consumer — merging the release pull request into `main` alone does not, since an immutable tag pin never moves on its own.** `/port:release` is what lands that merge and cuts the tag.

### Refreshing a GitHub-sourced install by hand

`git pull` does nothing for it — the loader never reads this working tree, only the fetched marketplace clone and the versioned cache. `/reload-plugins` does nothing either — the bytes already on disk are unchanged; there is nothing for it to reload. Under a tag pin, this recipe re-fetches the **same** tag `ref` already names, so it does not move a pinned consumer forward on its own — moving forward means changing `ref` first, which is what re-running `/port:init` does. To force a GitHub-sourced install to catch up to a real version bump:

```bash
claude plugin marketplace update port
claude plugin uninstall port@port --scope project
claude plugin install port@port --scope project
```

Then start a **new** session — an update never applies mid-session.

## Checking that a change parsed

```bash
claude plugin details port
```

This prints the component inventory. **A skill that fails to parse is silently absent from it rather than reported as an error** — so check that the counts went up, rather than looking for a complaint. It confirms the component parsed, not that the running session has it — that is confirmed only by invoking it.

After editing `marketplace.json` or `plugin.json`, re-validate them:

```bash
claude plugin marketplace update port
```

## Testing a change

Three layers, separated by cost: static file checks, artifact assertions on real pipeline runs, and behavioural evals. What to run and when is in [docs/TESTING.md](docs/TESTING.md).

## Writing hooks

Once installed at user scope the plugin loads in every session, whatever the working directory. A hook must therefore return immediately when the repository has no `.claude/port.config.json` — without that guard, installing this plugin changes behaviour in every unrelated project on the machine.

A hook records a harness decision; it never re-derives one. Re-implementing permission matching (or any other engine the harness already runs) as a second copy inside a hook drifts from the original and reports what the hook *predicts* happened rather than what actually did — the failure #63 fixed.

## Commit messages

Subject: `#<issue> <imperative lowercase summary>`, under 80 characters, no trailing period. Use `#0` when a commit genuinely has no issue.

Write the message to a file and `git commit -F <file>` rather than using inline `-m`, which collapses on Windows and drops the subject and co-authorship.

## Engineering standards

This repository has no standards document of its own yet. Until it does: small focused files, no dead scaffolding or transitional shims, comments only where a fluent reader would still get it wrong, and no placeholder content committed in anticipation of a later ticket.

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

The IPC contract between the main and renderer processes lives in `apps/desktop/src/shared/ipc.ts`: a request/response type map plus a runtime channel list, checked against each other at compile time. Add a channel to both, or `pnpm typecheck` fails.

The label vocabulary the app resolves lives in `apps/desktop/src/shared/labels/`, which imports the shipped `plugins/port/templates/labels.json` directly (`defaults.ts`) rather than carrying its own copy — this repository is the one consumer structurally able to, since it is bundled at build time from the same checkout. That import is the app's only copy of the vocabulary. Adding a label means editing the template plus `vocabulary.ts`'s `LABEL_KEYS`, or the `desktop-label-defaults` check in layer 1 fails (`docs/TESTING.md` → "Layer 1 — static checks").

These commands run in CI (`run-app-checks` in `.github/workflows/checks.yml`) on all three platforms, and are deliberately absent from `commands.checks` in `.claude/port.config.json`, which stays dependency-free — see `docs/TESTING.md` → "Layer 1 — static checks".
