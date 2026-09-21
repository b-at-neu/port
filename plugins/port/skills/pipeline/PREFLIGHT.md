# Startup preflight

Read alongside `SKILL.md`, not a standalone component — moved byte-identical out of `SKILL.md` (#181), since this block runs **once per session** while `SKILL.md` itself is re-injected on every tick. `SKILL.md`'s own "## Startup preflight" heading is a one-line pointer here; follow this document in full before the first tick, then return to `SKILL.md` for everything else.

## Startup preflight (before the first tick)

Run once, before the first tick — never on a wakeup, never acted on beyond what each step says. A refused or stopped preflight schedules no wakeup (see Pacing). **Step 0 — resolve the root, once, before any Read.** `git rev-parse --show-toplevel`, bound to `<root>`. Non-zero exit → not a git repository at all: emit the "nothing carries it" **UX states** message below with `<branch>` rendered as "no git repository here" and stop. **Every Read and Write this skill performs resolves against `<root>`, never against the session's transcript or project directory** — `.temp/` and `.agents/` paths are the one exception, touched only after `<root>` is established.

**Step 1 — config.** Read `<root>/.claude/port.config.json`. Present and parses as JSON → continue to step 2. Absent, or present but unparseable → treat a parse failure identically to absent, with the same hard-stop messages:

```bash
git rev-parse --abbrev-ref HEAD
git branch --sort=-committerdate --format='%(refname:short)'
git cat-file -e <ref>:.claude/port.config.json
```

A literal `HEAD` from the first command means detached — report the short sha instead. Take the **first 10** refs from the second command and test each directly with the third — one command per call, never a shell loop — rather than asking where the file was last *edited*, which answers a different question and breaks across a rebase. Emit the matching **UX states** message, naming the actual bound checked (`none of the <n> local branches I checked`, never "every ref I can see"), and **stop — no tick, no dispatch, no `ScheduleWakeup`,** with the checked-out branch unchanged: the guard hook denies `git checkout`/`git switch` from this session (see `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Cockpit rules"), so switching branches is never a route out — the only exits are checking out a branch that carries the config, or `/port:init`.

**Step 2 — permissions.** Read `<root>/.claude/settings.json`. Missing, unparseable, or `permissions.allow` absent or empty → warn with the matching **UX states** message and ask (`AskUserQuestion`): **Stop (recommended)** / **Start anyway**. Stop → end the session with no wakeup. Start anyway → continue, and never re-ask this session. The override exists because permissions can legitimately be granted at user scope, in `~/.claude/settings.json`, which this session cannot read — a hard stop would strand a valid setup on evidence it cannot gather.

Read `permissions.defaultMode` from the same file, for step 3's report. **Warn only when it is `acceptEdits`, `bypassPermissions`, or `auto`** — see the matching **UX states** message — and say in the same clause that a launch flag overrides this setting and cannot be read from inside the session. `default`, or the key absent (the harness's own default is `default`), needs no warning.

**Step 3 — running plugin identity, by commit, not path.** A path under `~/.claude/plugins/cache/` is identical for every install regardless of which commit it holds — a directory-sourced plugin is *copied* into the cache at install time, so the path alone cannot tell a stale copy from the working tree it came from. Report the resolved commit and scope instead:

1. Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` for the version string.
2. **Derive `<marketplace>`, `<plugin>` and `<version>`** from `${CLAUDE_PLUGIN_ROOT}`'s trailing path segments (`…/cache/<marketplace>/<plugin>/<version>`) — never hard-coded, and the whole basis of the generality that step 4's staleness lookup and its `known_marketplaces.json` key depend on. Read the plugin registry, `installed_plugins.json` — it sits **four directory levels above `${CLAUDE_PLUGIN_ROOT}`** when the running copy is a cache install, derived by trimming those four path segments — never a hard-coded `~/.claude/`. **Registry unreadable, or no record's `installPath` equals `${CLAUDE_PLUGIN_ROOT}`** → say so in one clause and fall back to the version-only line (see **UX states**); never print a path-only line that looks like an answer.
3. **Resolve the applicable record.** Among records whose `installPath` equals `${CLAUDE_PLUGIN_ROOT}`, apply **local > project > user** scope precedence; within a scope, prefer the record whose `projectPath` is this session's cwd or an ancestor of it.

**The sha about to be printed is the resolved record's `gitCommitSha` and nothing else** — never `git log`, never a commit that merely touches some repository file, never a path. If the sha about to be printed is not a prefix of the resolved record's `gitCommitSha`, print the **Registry unreadable** line instead of a sha. Open with one line naming the resolved short commit sha, scope, `projectPath`, the session's own model, and the mode read in step 2 — **no warning glyph on the model, ever**; it is information, not a check. Append step 4's staleness verdict, once it has run, in place of the plain scope clause — `current with <marketplace>@<target-ref>` when `behindBy` is `0`, or the **stale** UX state's warning form when it is not, or `staleness not computable — <reason>` when no target resolved:

> `port` v0.1.0 · `1a12608` (local scope, installed 2026-08-31) · current with `b-at-neu/port@dev` · model `claude-sonnet-5` · mode `default` (as configured — a launch flag overrides this and I can't read it from here)

When step 2 found a non-`default` `defaultMode`, replace the mode clause with the warning instead of the all-clear parenthetical:

> ⚠️ `.claude/settings.json` sets `permissions.defaultMode` to `acceptEdits` — your own edits in this session auto-accept, so anything unexpected here lands silently. Restart me in `default`.

**Two hazard warnings, checked against the resolved record(s), both from the same registry read — no extra call:**

- **The resolved record's `projectPath` is inside a managed worktree** (a `/.claude/worktrees/` path segment) — warn once: that install was made from a worktree, and because every install scope shares one `installPath`, that commit is what **every** session on this machine loads — worktree or not — and keeps loading after the worktree is gone. Reinstalling from the main checkout is the fix.
- **Two or more records share this running `installPath` with a different `gitCommitSha`** — warn once, naming both shas: whichever installed last wins globally, for every scope.

**Also warn when this session's own cwd is inside a managed worktree** (the same `/.claude/worktrees/` test), in this same preflight step, with the policy stated inline: never install or reinstall the plugin from here — the guard hook denies it (see `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Why background dispatch needs care"), because every install scope shares one `installPath` and the change would outlive this worktree.

Then check for self-host drift. Read `<root>/.claude-plugin/marketplace.json`:

- **Absent** — the normal case for a managed repository. Say nothing further.
- **Present and it declares a plugin whose `name` matches the running plugin** — this repository is the *source* of that plugin. If `${CLAUDE_PLUGIN_ROOT}` does not resolve to a path inside this working tree, warn once with the matching **UX states** message.

**Step 4 — integration drift, and plugin staleness relative to the remote.** Two purposes, one call, report-only, never acted on. Add `--include` so the response also carries the `Date:` header this step's cache-age rendering needs — the same header the Tick procedure already reads for its own clock:

**Resolve the staleness comparison target first**, from `~/.claude/plugins/known_marketplaces.json`, keyed by the `<marketplace>` segment step 3 already derived from `${CLAUDE_PLUGIN_ROOT}` — never from `repo`/`branches.integration`, which describe the *managed* repository and are only incidentally the same one here. **The ref about to be named is this resolved `<target-ref>` and nothing else** — never `branches.production`, never the plugin repository's own default branch guessed some other way; if the ref about to be named is not this one, render `staleness not computable` instead of a number:

- `source.source == "github"` → `<po>`/`<pn>` from `source.repo`; `<target-ref>` is `source.ref`, or that repository's default branch when unset.
- `source.source == "directory"` whose `path` is this working tree (the self-hosting case) → `<po>`/`<pn>` is `<owner>`/`<name>`; `<target-ref>` is `<integration>`.
- Anything else (a directory source pointing elsewhere, no marketplace record, no resolvable owner/name) → **not computable** — say so once at startup (see **UX states**) and omit the `pluginRepo` alias below for the rest of the session; never print a number.

When a target resolved, fold a second aliased root selection into the same query:

```bash
gh api graphql --include -f query='query {
  repository(owner: "<owner>", name: "<name>") { object(expression: "<integration>:.claude/settings.json") { ... on Blob { text } } }
  pluginRepo: repository(owner: "<po>", name: "<pn>") {
    ref(qualifiedName: "<target-ref>") { compare(headRef: "<installed-sha>") { behindBy } }
  }
}' --jq '{settings: .data.repository.object.text, behindBy: .data.pluginRepo.ref.compare.behindBy}'
```

Verify the field names against a live call during implementation; if `Ref.compare` is unavailable, fall back to `gh api "repos/<po>/<pn>/compare/<target-ref>...<installed-sha>" --jq '.behind_by'` and widen `allowed-tools` from `Bash(gh api graphql *)` to `Bash(gh api *)` — the repository allowlist already grants `Bash(gh *)`, so no settings change either way.

Compare the `settings` half's returned `enabledPlugins` keys against the local file's, and warn on either direction of difference, or on `object` being null (`<integration>` carries no settings file at all) — see **UX states**. **If the call errors, say so in one line and continue.** Never block a tick on it.

Also in this pass, when both files are present but the branch from step 1's `git rev-parse --abbrev-ref HEAD` is not `branches.integration`, warn once (see **UX states**) and continue. Silence is the correct output when everything lines up — beyond the plugin version line, a healthy preflight says nothing.

**Render the staleness half.** A null `pluginRepo`, a null `ref`, a null `compare` (GitHub cannot resolve the installed sha — routine under a directory source, where the commit may be local and unpushed), or an errored call all render as **not computable**, with the reason — never guess, never print a number, never block startup on it. Otherwise `behindBy` is the count: `0` folds into the version line as `current with <marketplace>@<target-ref>` (see step 3's opening line); non-zero renders the **stale** UX state instead, naming the count, the target, and the refresh-and-restart recipe. This first reading is usually `0` — a session is typically started right after installing — so it is the **per-tick recheck** (Tick procedure, Housekeeping) that actually catches drift accumulating *during* a long session, since the installed sha is fixed for the session and only the target ref moves.

**Step 5 — label vocabulary.** Every `--label` argument and every `--jq` label comparison this session issues, for the rest of its life, is copied out of the artifact this step produces — never retyped from memory or reconstructed from the table below.

1. **Resolve each key** as `labels[key] ?? default` — the repository's `labels` config for the override, this table for the default. A row's `Module` gates whether it applies at all; skip a row whose module is false in `modules`.

   | Config key | Default name | Role | Module |
   | --- | --- | --- | --- |
   | `marker` | `claude` | marker | core |
   | `autoPlan` | `auto plan` | marker | core |
   | `ready` | `ready` | trigger | core |
   | `planChangesRequested` | `plan changes requested` | trigger | core |
   | `planApproved` | `plan approved` | trigger | core |
   | `readyForReview` | `ready for review` | trigger | core |
   | `needsRevision` | `needs revision` | trigger | core |
   | `refreshBranch` | `refresh branch` | trigger | core |
   | `planning` | `planning` | in-flight | core |
   | `inProgress` | `in progress` | in-flight | core |
   | `reviewing` | `reviewing` | in-flight | core |
   | `revising` | `revising` | in-flight | core |
   | `refreshing` | `refreshing` | in-flight | core |
   | `planReview` | `plan review` | gate | core |
   | `blocked` | `blocked` | gate | core |
   | `needsHuman` | `needs human` | gate | core |
   | `prOpened` | `pr opened` | terminal | core |
   | `approved` | `approved` | terminal | core |

2. **Verify against the repository's real labels**, one call:

   ```bash
   gh label list --repo <repo> --limit 100 --json name --jq '.[].name'
   ```

3. **Write `.temp/label-vocabulary.md`** (Write tool) — the target `<repo>` this artifact was resolved for, a table of key, resolved name, and present/missing against that result, plus one verdict line: `verified` (every enabled label is present), `partial` (some but not all are present — the affected stages are invisible, distinct from a genuinely empty queue), `mis-resolved` (none are present — a resolution failure, never an empty backlog), or `unverified` (the `gh label list` call itself failed). `.temp/` is already gitignored.

4. **Echo the result once**, grouped by role so a wrong string stands out against its neighbours:

   - **Verified (verdict `verified`):**

     > **Label vocabulary** — resolved from `.claude/port.config.json` + defaults, all <n> present in `<repo>`:
     > triggers `ready` · `plan changes requested` · `plan approved` · `ready for review` · `needs revision` · `refresh branch`
     > in flight `planning` · `in progress` · `reviewing` · `revising` · `refreshing`
     > gates `plan review` · `blocked` · `needs human`
     > marker / terminal `claude` · `auto plan` · `pr opened` · `approved`

     Append one line per config override: `overrides from config: <key> → <name>`.

   - **Some names missing (verdict `partial`):**

     > ⚠️ <n> resolved label names do not exist in `<repo>`: `<name>`, `<name>`. Queries for them return nothing **silently**, so those stages are invisible. Run `/port:init` to create them, or fix `labels` in the config. I'll keep ticking and won't report "all clear" for the affected stages.

   - **No overlap at all (mis-resolved):**

     > ⚠️ **None** of the resolved label names exist in `<repo>`. That is a resolution failure, not an empty queue — I will not report "all clear" this session. The repository's labels are: `<name>`, `<name>`, … Fix `labels` in the config, then restart me.

   - **Verification unavailable:**

     > ⚠️ Couldn't read the label list for `<repo>` (`gh label list` failed: <reason>). Using the names resolved from config, unverified — an empty result this session is not evidence of an empty queue.

**Every tick after the first** reads `.temp/label-vocabulary.md` instead of re-deriving it — see Tick procedure, step 0. If the file is absent (a fresh session, or another checkout's leftover artifact with a different repository's vocabulary), re-run this section before that tick's queries.

**Step 6 — worktree reconciliation.** Read `commands.worktrees` (a `string | null` field — the full command prefix, e.g. `node scripts/port-worktrees.mjs`). **Absent or `null`** → say so once (see **UX states**) and skip this step entirely for the rest of the session — hygiene reports `not configured` in the tick's closing clause instead. **Set** → run it once, before the first tick:

```bash
<commands.worktrees> reclaim --max 5
```

Echo its output block verbatim — this is the ticket's "reconciled and reported on startup." It runs the identical safety rules a tick does (locked, dirty, and unresolved candidates are never force-removed), so nothing is reclaimed here that a tick would have refused. A non-zero exit is reported plainly, never treated as "nothing to reclaim."

**Step 7 — dispatch log.** **`commands.tick` set** — run `<commands.tick> start` now, instead of writing anything by hand below; it writes the engine's own `.temp/tick-state.json`/`.temp/dispatch-log.json` pair fresh, mints this run's `runId`, and appends a `run-start` event — skip the rest of this step and all of step 8, both already done. **`commands.tick` null** — `.temp/dispatch-log.md` is this session's own proof of what it has dispatched — the record the liveness cross-check reads to decide whether a stalled item is safe to reset. Write it fresh (Write tool), overwriting any prior session's copy: that overwrite *is* the session scoping, so no clock and no session id are needed.

```
# Dispatch log — <repo>

| Item | Stage | State | Resets |
| --- | --- | --- | --- |
```

Never acted on here beyond writing it. Every dispatch (see Dispatching) adds or updates the item's row; every tick's liveness step (see Tick procedure, step 5) reads it before classifying a no-match. A file whose `<repo>` header names a **different** repository — another checkout's leftover, or this checkout used for a different repository since — is treated as absent and rewritten fresh, exactly like a mismatched `.temp/label-vocabulary.md`. Two cockpits sharing one checkout clobber each other's copy; that degrades both to report-only on liveness, which is the safe direction, never a false reset.

**Step 8 — tick state** *(`commands.tick` null only — step 7's `start` call already did this when it is set)*. `.temp/tick-state.md` is the only memory that survives from one tick to the next — everything else (the pacing ladder, the resume line, the denial-log offset, the change-only reports) needs to know what the *previous* tick already told the human, and nothing else records that. Write it fresh (Write tool) exactly like `.temp/dispatch-log.md` — that overwrite *is* the session scoping, and a `Repo` header naming a different repository is treated as absent, same as a mismatched vocabulary file.

```
# Tick state — <repo>

Repo: <repo>
Last tick:
Scheduled:
Cadence step: 0
No-change ticks: 0
Denials consumed: <baseline>
Announced approved:
Unowned reported:
Ungated reported:
Worktrees reported:
Uncorrelatable announced:
Plugin staleness: <not computable | N>
Refreshed:
Budget holds:
```

Baseline `Denials consumed` with one call, and report nothing from the log on this first tick — a fresh session has no prior offset to diff against, so there is nothing new to report, not zero:

```bash
wc -l ".agents/denials.log"
```

If the file does not exist, baseline at `0`. Every field after this step is written and read exactly where its own procedure names it — the ladder in Pacing, the resume line and denial offset at the top of the Tick procedure, the three change-only reports in Housekeeping, `Refreshed:` in the Refresh sweep, and `Budget holds:` in the Budget gate.

**Step 9 — budget reset.** Read `commands.budget` (a `string | null` field — the full command prefix, e.g. `node scripts/port-budget.mjs`); **absent or `null` → skip silently, say nothing** for the rest of the session — no dispatch ceiling and no cost reporting, matching `commands.artifacts`. **Set** → run `<commands.budget> reset` once, before the first tick, closing any open dispatch a crashed prior session left running (flushed to its ticket's ledger as `lost`); echo its output only if it closed anything.

## UX states (startup preflight)

Exact copy, one message per state, `<…>` substituted:

- **Config absent or unparseable, other refs carry it** (hard stop):

  > ⛔ Not port-managed on this branch. `<.claude/port.config.json is absent | .claude/port.config.json fails to parse as JSON>` on `<branch>`, but it exists on `<refs>` (of the `<n>` local branches I checked). Check one of those out and start me again — I'm not ticking until then.

- **Config absent or unparseable, nothing carries it** (hard stop; also covers "no git repository here", with `<n>` at `0`):

  > ⛔ Not port-managed. `<.claude/port.config.json is absent | .claude/port.config.json fails to parse as JSON>` on `<branch>` and on none of the `<n>` local branches I checked. Run `/port:init` to adopt the pipeline here. Not ticking.

- **Permissions missing or empty** (warn, then Stop / Start anyway):

  > ⛔ `<.claude/settings.json is absent | permissions.allow is empty>` on `<branch>` — there are no project permission rules on disk. Stage agents run in `dontAsk` mode and auto-deny anything not allowlisted, so every one of them would fail every command with no prompt and no visible reason. Re-run `/port:init` on this branch, or check out the branch it was installed on. If your permissions live at user scope I can't see them from here — say so and I'll start anyway.

- **On a non-integration branch, both files present** (warn, continue):

  > ⚠️ You're on `<branch>`, not `<integration>`. Dispatched agents work in worktrees cut from `<integration>`, so they use the *committed* config and permissions from there — not what's on disk here. Changes on this branch reach them only once they merge.

- **`<integration>` declares plugins this checkout does not** (warn, continue):

  > ⚠️ `<integration>` declares plugins this checkout doesn't: `<names>`. Pull `<integration>` and restart me, or agents I dispatch won't have them.

- **This checkout declares plugins `<integration>` does not** (warn, continue):

  > ⚠️ This checkout declares `<names>`, which `<integration>` doesn't carry yet. They reach dispatched agents only once merged — land that on its own ticket and mark anything that needs it blocked by it.

- **`<integration>` carries no settings file at all** (warn, continue):

  > ⚠️ `<integration>` has no `.claude/settings.json`. Every worktree cut from it starts with no permission rules, so dispatched agents will auto-deny everything. Merge the harness to `<integration>` before dispatching.

- **Drift query failed** (one line, continue):

  > Couldn't read `<integration>`'s settings to check for plugin drift — skipping that check this session.

- **Self-host drift** (warn once):

  > ⚠️ This repository is the source of the `port` plugin, but this session is running <path>, not the working tree. Edits here — and `git pull` — have no effect on this session. Refresh the installed plugin and restart this session to pick up edits made here.

- **Registry unreadable** (fall back to the version-only line):

  > `port` v0.1.0 — commit unresolved (couldn't read the plugin registry) · model `claude-sonnet-5` · mode `default`. The path alone can't tell a stale copy from your working tree, so treat the version as unverified.

- **Running plugin, stale relative to the remote** (warn, in place of the plain scope clause):

  > ⚠️ `port` v0.1.0 · `4634fc1` (project scope, installed 2026-08-23) · **42 commits behind `b-at-neu/port@dev`** — I'm running a copy from before those merged, so I'm following the older rails whatever `dev` says. Refresh the installed plugin and restart me. · model `claude-haiku-4-5` · mode `default`

- **Staleness not computable** (substitute the reason: no install record matched this directory · the record has no `gitCommitSha` · no marketplace record for `<marketplace>` · the source is a directory outside this working tree · GitHub can't resolve `<sha>`, so it was probably never pushed):

  > `port` v0.1.0 · `4634fc1` (project scope, installed 2026-08-23) · staleness not computable — `<reason>` · model `claude-haiku-4-5` · mode `default`

- **Install record pinned to a worktree** (warn once):

  > ⚠️ The install record for `port` was made from `<path>`, a worktree — and every install scope shares one `installPath`, so that commit is what **every** session on this machine loads, worktree or not. Reinstall from the main checkout to correct it.

- **Two records differ only by commit** (warn once):

  > ⚠️ Two install records share `<path>` with different commits (`<sha1>`, `<sha2>`) — whichever installed last wins globally. Running `<sha>`.

- **This session's own cwd is inside a managed worktree** (warn once):

  > ⚠️ You're running me from `<path>`, a managed worktree. Don't install or reinstall the plugin from here — the guard hook denies it, because every scope shares one `installPath` and the change would follow you out of this worktree.

- **`commands.worktrees` not configured** (say once at startup, then a closing-line clause every tick thereafter):

  > ⚠️ `commands.worktrees` isn't set, so I can't reclaim worktrees — and the pipeline creates one per ticket. Re-run `/port:init` to install the script, or run `/port:worktree-clean` by hand.
