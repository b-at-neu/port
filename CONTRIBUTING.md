# Contributing

## Working on the plugin

This repository is both a plugin marketplace and the plugin it distributes. `README.md`'s install command — `claude plugin marketplace add b-at-neu/port --scope project` — is the **consumer** path: it is what a managed repository commits so the pipeline travels with the checkout. It is wrong here, because this repository's own committed `.claude/settings.json` already carries a **project**-scope `port` marketplace entry, and a plain `marketplace add` with no `--scope` writes **user** scope — which project scope silently outranks. Following the README's instructions unscoped in this repository looks like it worked and changes nothing.

The only scope that outranks the committed project-scope entry is **`local`** — gitignored, machine-specific, and exactly what a local-directory dev loop needs:

```bash
claude plugin marketplace add /absolute/path/to/port --scope local
claude plugin install port@port --scope local
```

This writes to `.claude/settings.local.json`, already covered by this repository's `.gitignore`.

Edits under `plugins/port/` take effect immediately — there is no build step and nothing to invalidate. A session that is already running has loaded its components, so run `/reload-plugins` there to pick up changes. **Confirm the override actually took** by checking the cockpit's first line (see "Report the running plugin" in `pipeline/SKILL.md`): a path under `~/.claude/plugins/cache/` means you are still running the committed GitHub-sourced copy, not your local checkout.

### The three gates on a GitHub-sourced install

An install from a `github` marketplace source — the consumer path, and this repository's own committed entry — advances only when all three of these line up. Any one wrong, and the running copy silently never changes:

- **`version`** in `plugins/port/.claude-plugin/plugin.json` — the release signal. The plugin's on-disk cache directory is keyed by this string (`~/.claude/plugins/cache/port/port/<version>/`), so `claude plugin marketplace update port` refreshes the marketplace's own clone but **cannot advance a pinned install** whose version has not moved.
- **`ref`** — defaults to the marketplace repository's *default* branch when unset. For `b-at-neu/port` that is `dev`, the integration branch, not a release line; the committed entry pins it to `main` for exactly this reason.
- **`autoUpdate`** — off by default for third-party marketplaces, so even a real version bump on `main` sits unfetched until this is `true` or someone updates manually.

One line covers all three: **pushing to `main` releases nothing; a version bump does.** `/port:release` is what performs that bump.

### Refreshing a GitHub-sourced install by hand

`git pull` does nothing for it — the loader never reads this working tree, only the fetched marketplace clone and the versioned cache. `/reload-plugins` does nothing either — the bytes already on disk are unchanged; there is nothing for it to reload. To force a GitHub-sourced install to catch up to a real version bump on `main`:

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
