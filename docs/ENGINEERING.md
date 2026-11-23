# Engineering Standards

Every pipeline agent reads this document before working. It defines the quality bar beyond what is obvious from the code. Plans must account for it per feature, implementations must follow it, and review findings may cite its sections the same way they cite the plan.

This is **this repository's own** standards document, not a template — `plugins/port/templates/ENGINEERING.template.md` is the skeleton `/port:init` installs elsewhere. Concrete paths like `plugins/port/**` are therefore correct here, and only here.

**§1–§8 cover the plugin, `scripts/` and anything shared; §9 covers `apps/desktop`.** Where the two overlap, §9 wins for desktop code.

**Where things live is not this document's job.** [ARCHITECTURE.md](../ARCHITECTURE.md) is the canonical repository map and the authority on the ship boundary; it carries its own layer 1 pin (`scripts/checks.ts` → "Repository map covers the real tree, both directions"), so restating its table here would create a second copy with nothing pinning it — exactly what §2 forbids. This document covers *how* to write, not *where* to put it.

**Citations name checks and sections, never line numbers.** `scripts/checks.ts` and `docs/PIPELINE.md` are the two most-churned files in the repository, so a line reference in either is stale within days. Every citation below names a `// --- ` check block or a markdown heading, both of which survive edits and file splits.

**Stack:** Markdown agent and skill definitions (the product) · Node.js ESM scripts in TypeScript, type-stripped at load with zero runtime dependencies (static checks, artifact validation, worktree reclamation), at or above `package.json`'s `engines.node` floor · JSON Schema draft 2020-12 · GitHub Actions · `gh` CLI for all GitHub I/O · a pnpm workspace with TypeScript, Electron and zod (`apps/desktop`)

## 1. Architecture

`plugins/port/docs/PIPELINE.md` is the single source of truth for operating rules, the label lifecycle, the permission model, and every output format. Every agent and skill references it and restates **only** what is unique to itself. A rule belonging to more than one stage goes there, not into each stage — and when it must appear in several files, it goes in as a byte-identical block with a pin (see §2).

### Rules

**Hook and script code separates pure decision logic from I/O.** `hooks/lib/guard-rules.mjs` exports pure functions unit-tested directly; `hooks/agent-guard.mjs` is the thin stdin/stdout/exit-code wrapper, tested separately by spawning the real script ("Guard hook classifier" and "Guard hook end-to-end wiring"). The same split applies to the worktree reclamation script ("Worktree reclamation classifier"). New logic goes in the library, not the wrapper — the wrapper's tests cannot see a classifier bug and the classifier's tests cannot see a wiring bug.

**Scripts follow one runnable entry point plus a shared library.** `scripts/checks.ts` is a runner that only wires — it discovers and imports every `scripts/checks/<topic>.ts` module from disk, awaits each in turn, then calls `report()`, with no assertions and no hand-maintained module list of its own. Each topic module exports a function taking the reporter, typed `Reporter` (`scripts/lib/report.ts`). A topic module asserts a single condition with `expect(cond, check, detail)`, reaching for `fail`/`ok` only when the logic genuinely branches — an `else if` chain, a loop that fails per item, or a block with a side effect. `scripts/lib/report.ts` is a deliberately dumb collector and printer, shared by layers 1 and 2, which "decides nothing" (its own header); `scripts/lib/files.ts` holds the file-system helpers (`root`, `readJson`, `walk`, `frontmatter`) the topic modules share. A new check goes into the topic module it belongs to, never into the runner — nearly every plugin or `scripts/` ticket adds a regression guard, so a runner that reabsorbed assertions directly would recreate the file-contention bottleneck the split exists to remove (`PIPELINE.md:95-114`). Source is type-stripped, never type-checked at runtime: `scripts/lib/errors.ts`'s `message(e: unknown): string` is the one helper every `catch` site imports rather than casting `e` by hand, and JSON read off disk (`readJson`) stays `any` — a port config's shape and defaults come from `schema/port.config.schema.json`, never a hand-transcribed TypeScript interface (§2's own rule, restated for `scripts/` specifically).

**The trajectory record is write-only from the tick engine's own decision path.** `scripts/port-tick/events.ts` (the emitter) exports no function whose name contains `read` or `parse`, and nothing under `scripts/port-tick/` besides `port-tick.ts` and `report.ts` itself may import `events.ts` or `report.ts` ("Write-only rail", `scripts/checks/tick-events.ts`) — an append-only history that fed a future tick's decision would quietly break `plan`'s own never-persists invariant (#203).

**A file that an adopting repository copies alone must be self-contained.** `plugins/port/bin/artifacts.mjs`, `bin/worktrees.mjs`, and `bin/budget.mjs` carry no relative imports, because an import resolving only inside this checkout breaks silently for every adopter while passing here — checked directory-wide, not per file ("bin/ holds only self-contained .mjs", `scripts/checks/layout.ts`). Cross-platform behaviour is part of the same contract — these run on an adopter's Windows machine, not just this one, which is why `bin/worktrees.mjs` and `bin/budget.mjs` also carry their own `execSync`/`shell: true` bans in `scripts/checks/cockpit.ts` and `scripts/checks/budget.ts`. This is also why §7's line limit exempts `bin/` instead of splitting it: the runner-plus-modules split every other over-limit file uses would break this same self-containment guarantee (#183).

**`plugins/port/` is one contract per directory (#171).** `templates/` holds only fill-in templates a `/port:init` or `/port:analyze` run substitutes into; `bin/` holds only self-contained executables copied verbatim into a managed repository, some of which this repository also runs in place; `data/` holds only canonical data — currently `labels.json` (the seven app labels) and `labels.legacy.json` (the frozen 17), each of which the desktop app carries a byte-identical copy of under `apps/desktop/src/utils/labels/`, pinned by `labels-display-copy` and `desktop-label-copy`. `scripts/checks/layout.ts` pins all three, plus the absence of any tracked file still naming one of the three moved files under its old `templates/`-relative path.

**No repository-specific value is ever a literal in prompt text.** Label names, check names, branch names, and the repository slug are resolved from `.claude/port.config.json` or from PIPELINE.md's default table at read time. A literal label name silently matches nothing — `gh issue list --label <unknown>` exits 0 with an empty result — and a literal CI check name breaks the moment a repository renames its workflow job ("No config key appears as a literal --label argument", "Generality guard — no literal CI check name in a stage prompt"). The test to apply: **would this behave correctly in a freshly `/port:init`-ed repository with renamed labels, a single branch, and a different set of CI checks?**

**Anything shipped may only reference other shipped paths.** A reference from a file under `plugins/port/` to a repository-only doc or script — `docs/USAGE.md`, `CONTRIBUTING.md`, `scripts/checks.ts` — dangles in every adopter's plugin cache, which carries only `plugins/port/` (`scripts/checks.ts` → "Shipped references stay inside plugins/port/").

**Under the root `scripts/`, a cross-folder import uses the root `package.json`'s `imports` map** — `#lib/…`, `#port-tick/…`, `#plugins/…`, `#desktop/…` — never a `../` relative path; a `./` import within the same folder is fine. `scripts/checks/scripts-imports.ts` enforces it: no `../` left in `scripts/`, every `#` specifier resolves against the `imports` map, `./lib/` stays inside `scripts/lib/` itself, and a `scripts/port-tick/*` module that `apps/desktop/src` imports stays free of `#` aliases.

## 2. Data and integrity

`.claude/port.config.json` validates against `schema/port.config.schema.json` (draft 2020-12). Fixtures come in pairs — `schema/fixtures/valid.*.json` must validate and `invalid.*.json` must be rejected — and both directions are asserted, because a fixture set that only proves acceptance proves nothing ("Schema fixtures still discriminate", plus the `run-schema-fixtures` CI job which does the full validation layer 1 deliberately cannot).

**Any content duplicated across files gets a mechanical assertion pinning the copies together, in both directions — never a "keep in sync" comment.** This is the repository's most consistently applied rule.

**If a change introduces a further copy of anything, it introduces its pin in the same commit.** A comment asking a future reader to remember is not a pin.

**Config shape is asserted, not assumed.** `commands.checks` entries must be `{run, fix}` objects: a bare string is still valid JSON and reads plausibly while every consumer reading `entry.run` gets `undefined` ("The config template matches its own schema's shape").

## 3. Security

**Broad allow, authoritative deny.** The allowlist grants whole development-command categories; the deny list is the real safety surface for dangerous or interactive commands, and deny beats allow at every scope. Any permission change is reflected in both `templates/permissions.base.json` and PIPELINE.md's permission model section.

**The `PreToolUse` guard hook is the enforcement.** `permissionMode: dontAsk` in agent frontmatter stays as declared intent and a second line of defence, but has never been observed denying anything on its own (PIPELINE.md → "Why background dispatch needs care"). When a denial matters, the hook is what must change and what must be tested.

**The guard's rails are not subagent-only.** Two apply to any caller including the cockpit's own session, because the cockpit violated them under throughput pressure: no `gh`/`git` inside a shell loop, and no clearing `<labels.needsHuman>` unless a recent operator message names that item. A third denies plugin install or marketplace mutation from inside any worktree, since every scope resolves to the same on-disk `installPath` and would silently repoint every session on the machine.

**`sessionRequiredPaths` is a harness-level boundary no dispatched subagent can cross, and settings cannot grant it back.** A plan writing under those paths routes to `/port:implement` in an operator session; it is never worked around. In the desktop app, a stage session's edit under one of those paths pauses for operator approval instead, never a second `/port:implement`.

**A hook returns immediately outside a port-managed repository.** Installed at user scope the plugin loads in every session, so without that guard, installing it changes behaviour in every unrelated project on the machine.

**A hook records a harness decision; it never re-derives one.** Re-implementing permission matching inside a hook drifts from the original and reports what the hook *predicts* happened rather than what did.

**Known gaps are documented rather than silently tolerated:** shell redirection through an allowed command cannot be denied by pattern, because matching operates on parsed tokens while redirection is consumed by the shell; and a native `permissions.deny` match is not logged. "Write files with Write and Edit" is therefore a convention agents follow, not a technical guarantee.

## 4. Operator-facing completeness

The users of this system are operators reading GitHub and a terminal, so "user-facing" means every plan, review, comment, and cockpit line.

**Writing style, every output** (FORMATS.md → "Writing style"): bullets and short sentences over paragraphs, one idea per bullet · never restate context the reader already has, reference it · omit sections that do not apply, with no "N/A" or "None" filler · no meta-commentary about the document itself · say each point exactly once, never across body, inline, and summary.

**Every failure mode states, in writing, which direction it fails toward and why.** Both directions are chosen deliberately and neither is a default:

- `SESSION REQUIRED` detection **fails open** toward dispatch, because a false positive stalls an item forever and invisibly while a false negative costs one denied edit and a retry.
- The tick **fails closed on actions, never on reporting**: a blind tick dispatches nothing, runs no hygiene, resets nothing, and never claims "all clear" — but still schedules the next wakeup.
- The CI merge gate is **deliberately fail-open** on an unlabelled pull request, with the mitigations named upstream.
- A `CLAUDE.md` override **fails closed on the entry, open on the run** (#246): a refused line leaves the port default standing for that one field, reported, never silently applied — but a wholly malformed `port-overrides` block never aborts config loading, since a repository whose whole block is broken must still run on port defaults rather than halt. The desktop app (#300) differs on an *unreadable* file rather than a malformed one: the cockpit's own `loadConfig` catches a read error as "absent" and runs on port values, but the app fails the whole repository closed (`effective-config-unreadable`) instead, since an unread override could rename a label or change a gate it would otherwise act on by the wrong name.

**A blocked or denied action is reported exactly, never retried or routed around.** Emit `BLOCKED: <exact denied command + what you needed>` and stop; a denied command returns a hook decision with a reason, not a prompt.

**An absent signal is never read as a passing one.** An empty check rollup is pending, not green; a check with no conclusion has not passed. No verdict is formed while any check on the head commit is pending, or on a pull request GitHub reports `CONFLICTING`. Liveness is a `TaskList` call, never inferred from a label — an in-flight label means a stage *claimed* an item, never that anything is still running ("Liveness is a TaskList call, never a label inference"). The same rule holds for a GraphQL fetch: a non-2xx status, or a non-zero `gh api graphql` exit in the plugin's scripts, is not evidence of no data — a response can carry `errors` beside usable `data`, so the envelope is always parsed in full rather than trusted or discarded by status or exit code alone. Only the aliases actually named in `errors[].path` are treated as unavailable; every other alias in the same response is trustworthy. A GraphQL call is never filtered with `--jq`, since `gh` silently skips that filter on exactly the partial-error response this rule exists to read, and no code path returns an empty result set for a request that did not actually succeed.

**A denial log's line count is never presented as a denial count, and an unresolvable session id fails toward `unknown-session` rather than a guessed role** — the log's line total conflates real denials with allowlist misses and rail holds, and a wrong attribution is unrecoverable misinformation an operator would act on. **A capped read's groupings are reconciled against `window` (the analysed entries), never against the whole-file `summary`** — the two describe different line sets whenever the log exceeds `limit`, so comparing a grouping total to `summary` is a scope mismatch, not a counting bug (#333).

**A local transcript's recency is activity, never liveness.** Nothing readable from a file on disk proves a process is running — a crashed agent's transcript looks identical to a live one's, only older. A session adapter therefore reports last activity, never a `running`/`alive`/`isLive`-shaped field. A stall is a **report, never a proof**: `TaskList` remains the only real liveness evidence, and a session read that could not run never produces one, since a check that could not run is not a check that found nothing.

**A path is not evidence.** Reporting a derived fact means resolving it, not pattern-matching a string that correlates with it: the running-plugin tell resolves the install record's commit sha rather than printing a cache path, because the path-based version reported "stale" every time under a directory source ("Running-plugin staleness is resolved, not printed from a path").

**Large or fenced markdown never goes inline to `gh`.** Write the payload under `.temp/` and pass `--body-file` or `--input`; shell quoting of backticks and code fences fails cross-platform.

## 5. Accessibility

Narrow but real, because the pipeline's whole visible state is a set of GitHub labels.

**Label colour encodes the pipeline phase by hue and position by lightness.** One palette per phase (plan, implement, review, revise, refresh, needs-you, done), the same hue on GitHub, the Board pill and the sidebar dot. Each label wears its palette's light dot, which is exactly the app's light-theme dot; the legacy set keeps its shades, with a queued trigger lighter than the in-flight label and its needs-you gates two steps apart (`DC2626` → `991B1B`) so they separate by lightness under red-green colour vision deficiency. `scripts/checks/phase-palette.ts` enforces the pill-text and dot contrast in both themes; the hue and lightness rules stay as prose. Every colour is a well-formed six-digit uppercase hex and no two labels share one ("Label colours are well-formed and distinct").

**Severity is never colour-only.** Review findings carry both an emoji and the word: 🔴 Critical · 🟠 Medium · 🟡 Low · ⚪ Nit.

**The desktop app's screens meet WCAG AA**, built to `docs/DESIGN.md`:
- Text contrasts at least 4.5:1 with its background, and focus rings and status dots at least 3:1. `DESIGN.md` §1 records what each token pairing measures and the two rules that follow from the failing ones.
- Status is never colour-only: every pill and phase carries its name in text, and the phase bar has a tooltip.
- Every action is reachable by keyboard, with a visible focus ring. An icon-only button has both a tooltip and an accessible name.
- No text is smaller than 11px, and no click target is smaller than 24px.
- The OS reduce-motion setting turns off every transition and the attention pulse.

## 6. Performance

**Cost is measured, then reduced, then pinned.** The polling tick collapsed from roughly 15 GitHub round trips to one aliased `gh api graphql --include` call, and layer 1 now fails if a per-label poll creeps back under the Tick procedure heading ("Collapsed tick query — one round trip, never a per-label poll"). The desktop app's own poll cost 146 points per read with one per-label connection pair, since GitHub prices a connection at its page size, not at what comes back; a two-connection sweep plus a per-number detail read costs 5, measured live against this repository, and does not grow with the number of enabled labels. GitHub polling runs on two tiers. A 60s full sweep carries everything, CI checks and reviews included; underneath it, a 10s issues-list ETag pre-check triggers an early sweep only when something changed. A `304` costs nothing against either bucket and a changed ETag's `200` costs one `core` point, so one repository's pre-check spends at most 360 `core` points an hour. Every sweep, regular or triggered, is stretched from the reported cost so projected hourly use, across every registered repository, stays under half the reported limit: at 5 points a sweep, one repository at the 10s floor projects at most 1,800 of the 2,500-point share, and from the second repository on the share math, not the floor, sets the gap. A desktop unit test recomputes the one-repository relationship from the constants.

**Polling adapts to whether anything can move without a human.** The pacing ladder holds at a 270s floor whenever something will progress on its own, and otherwise backs off one rung per consecutive no-change tick — 270 → 540 → 1080 → 1800 — resetting to the floor on any observed change. The cockpit **never stops scheduling wakeups while it owns the checkout**, since it is the only dispatcher while that holds. The one carve-out (#331): once `.agents/cockpit.json`'s verdict reads `app` or `unreadable`, this cockpit has nothing left to do — no gate to answer, no dispatch to make — so it reports and stops scheduling wakeups entirely, an explicit exception to "never stops" rather than a slower rung of the same ladder. The constants and both preconditions are literal, checkable phrases ("Pacing ladder").

**No busy-waiting.** Bounded waits use a real timeout and a capped retry count; a bare `sleep`-shaped wait is a layer 1 failure ("No busy-waiting in the cockpit skill"). The next scheduled tick is how this system waits.

**Expensive work runs proportionally to what changed.** Layer 1 is free and runs on every pull request, across a three-OS matrix; schema validation and `apps/desktop`'s typecheck, lint, test and build run as their own jobs; installers build in their own path-filtered workflow; layer 3 evals are path-filtered to prompt changes only. **Neither the evals nor the layer 2 audit may ever enter `commands.checks`** — that list is what `impl-agent` runs before pushing, so an eval there means every dispatched agent spawning its own model runs ("Behavioural evals never enter commands.checks").

## 7. Quality bar

**Comments are rare and one line.** A comment explains only what the code cannot say itself — a non-obvious constraint, or why something unusual is necessary. Never restate the code, and never cite a ticket, pull request, or issue number; version control already links every line to its change. Design decisions and history live in docs or in the tickets, not in code comments. Enforced by the "Comment ratchet" check: per-area ceilings in `scripts/checks/comments.config.json` that may only be lowered, and a new file must be clean. A check block may open with one header line naming the failure it catches — no issue number.

**Small, focused files. No dead scaffolding, no transitional shims, and no placeholder content committed in anticipation of a later ticket.** A source file is at most 500 lines. Each exclusion below is mirrored one-for-one by an `exclude` entry in `scripts/checks/file-size.config.json`, pinned in both directions by the "File size limit" check:

- `pnpm-lock.yaml` — a generated index, never hand-authored.
- `schema/fixtures/**` — fixtures whose entire content is the thing under test.
- `plugins/port/bin/**` — every file there is copied alone into an adopting repository (§1), so the runner-plus-modules split is unavailable by construction. A permanent exemption, not debt, so it never enters the allowlist (#183).

An over-limit file outside these exclusions is split by topic, following the runner-plus-modules shape §1 describes for `scripts/checks.ts`. `scripts/checks/file-size.config.json`'s `limit` is this same number, checked by "File size limit and the shrinking ratchet"; its `allowlist` enumerates every file still over the limit with its exact current line count, as a ratchet — an entry may only be lowered, never raised, and removing a path from the allowlist is the definition of done for it.

**`scripts/` runs `noUncheckedIndexedAccess: false`, deliberately, unlike `apps/desktop`.** `tsconfig.base.json` turns it on for `apps/desktop`, where an indexed read crosses module boundaries and a bad index is a crash in the UI. In `scripts/` a regex-capture or `split(…)[n]` read sits either inside an `if (!m) { fail(…); }` guard or on an array the same function just built — the check's own `fail()` call *is* the error path — so a non-null assertion at every such site would add density, not information. `tsconfig.scripts.json` also sets `erasableSyntaxOnly: true` (rejects `enum`/`namespace`/parameter properties — exactly what Node's own type stripping cannot erase, so an unrunnable file fails in CI rather than at an agent's push) and `allowImportingTsExtensions: true` (import specifiers are the literal on-disk `.ts` path; Node never rewrites extensions).

**A check that cannot be made to fail is not a check.** Every validator pattern is asserted against both a passing and a failing example, using the real historical failure where one exists ("Artifact validator's patterns accept a good example, reject a bad one"). Every new rule is worth breaking deliberately once, to confirm it catches anything at all.

**A check must be able to distinguish the state it exists to detect.** `diff -rq` returned silence while both the cache and the checkout sat 42 commits behind `origin/dev` — a verification that passes in exactly the situation it was written to catch is worse than none, because it converts an unknown into a false assurance. Prefer a check whose failure mode you have observed.

**In the plugin and `scripts/`, every fixed regression leaves a mechanical guard behind, and duplicated content leaves a mechanical pin behind.** Layer 1 pins the literal phrase or contract that constituted the fix, so a future edit quietly reverting the reasoning fails in CI rather than in a live pipeline run. A prose-only fix to a prompt is incomplete. A duplicated copy gets the same treatment: a check that asserts the two sides agree. In `apps/desktop`, a fixed regression in a decision leaves a table case or a scenario test (§9), never a source-text check.

**Rails are checkable preconditions, not bare prohibitions.** "Never do X" prose was violated twice under throughput pressure. A rail is instead shaped as something testable — `unblock #N` before a gate clears, "only when a check on it has gone red" before `approved` is removed — and layer 1 fails if either reverts to prose with nothing to check ("Cockpit rails stay checkable preconditions, not bare prohibitions").

**Component frontmatter is exact.** `name` must equal the file's basename for an agent and its directory name for a skill, and `description` must be non-empty ("Components parse and declare what they must"). A malformed component is *absent* from Claude Code's inventory rather than reported as an error, so nothing complains.

**Eval discipline:** one behaviour per case — if a grader needs "and", it is two cases · apply pressure, since a rule is only worth testing where following it costs something · grade the artifact, not the narration · name the failure the grader exists to catch at the top of the grader.

**Commit subjects are `#<issue> <imperative lowercase summary>`**, under 80 characters, no trailing period, `#0` when a commit genuinely has no issue. Write the message to a file and use `git commit -F <file>`, never inline `-m`, which collapses on Windows and drops the subject and co-authorship.

## 8. Pre-pull-request self-check

- [ ] Is this checkout current? `git rev-list --count HEAD..origin/dev` must be `0` — analysis and citations from a stale tree are wrong in ways that look right.
- [ ] Every new or changed agent/skill has valid frontmatter: `name` matches its file or directory name, `description` is non-empty.
- [ ] If a Bash-granting agent was touched, its shell-discipline, label-cas, and standards-precedence blocks are still byte-identical to PIPELINE.md's canonical copies.
- [ ] No label name, CI check name, branch name, or repository slug appears as a literal in prompt text.
- [ ] Would this behave correctly in a freshly `/port:init`-ed repository with renamed labels, a single branch, and different CI checks?
- [ ] Any content newly duplicated across two files has its mechanical pin added in the same commit.
- [ ] If a pinned file changed, its counterpart still agrees — and layer 1 says so, in both directions.
- [ ] Every new check was made to fail once before being trusted to pass, and can distinguish the state it exists to detect.
- [ ] A new layer 1 check lives in its topic module under `scripts/checks/`, never in the runner.
- [ ] In the plugin or `scripts/`, a fixed regression leaves a layer 1 guard behind.
- [ ] A new rail is a checkable precondition, not "never do X" prose.
- [ ] Any new failure mode states which direction it fails toward, and why.
- [ ] An absent signal is not treated as a passing one — no empty rollup, missing conclusion, or exit code read as success.
- [ ] A derived fact is resolved, not inferred from a path or a label.
- [ ] No new code takes a pipeline decision from a label.
- [ ] A file an adopter copies alone has no relative imports and works on Windows.
- [ ] No inline `--body "..."` carrying markdown or fences — written under `.temp/` and passed as `--body-file`.
- [ ] New paths are reflected in `ARCHITECTURE.md`, and shipped files reference only shipped paths.
- [ ] Every comment added is one line, explains a constraint or an unusual why, and cites no ticket number.
- [ ] `node scripts/checks.ts` passes locally before pushing.
- [ ] `pnpm typecheck:scripts` passes, and no new file crosses the `noUncheckedIndexedAccess`/`erasableSyntaxOnly` boundary `tsconfig.scripts.json` sets for `scripts/`.
- [ ] No file under `plugins/port/` carries a `.ts` extension — type stripping needs the Node floor `package.json`'s `engines.node` sets, which an adopter never agreed to.
- [ ] Commit subjects are `#<issue> <imperative lowercase>`, under 80 characters, no trailing period.
- [ ] No file crossed the line limit, and no allowlisted file grew.

## 9. Desktop app

These rules apply to everything under `apps/desktop`. Code written before a pattern existed is migrated by the simplification tickets. A change to such code follows the pattern for whatever it touches, and never adds a new instance of the old shape.

### Layout

- Main-process code lives in `main/features/<feature>/`. Platform adapters live in `main/platform/`. The composition root (AppContext construction and the router) lives in `main/app/`.
- Renderer screens are `renderer/pages/<page>/`. Shared renderer pieces live in `renderer/components/` and `renderer/data/`.
- Code shared by main and the renderer is pure and lives under `utils/`. `types/` holds only types that have no runtime schema.
- A cross-folder import uses `@/<top-level>/…`. A `../` import is an error.
- `apps/desktop/src` imports nothing from `scripts/` or `plugins/`.
- The renderer imports nothing from `main/`, and one page never imports another page's folder.
- Each of these rules is an ESLint rule in `apps/desktop/eslint.config.mjs`.

### Patterns

One contract per pattern: its location, its naming, and what it may import.

- **Action.** One file per action, `main/features/<feature>/actions/<verb>.ts`, named `'<feature>.<verb>'` and built with `defineAction({ name, kind: 'query' | 'mutation', input, run(ctx, input) })`.
  - The input is validated before `run`.
  - It may import its own feature's modules, `utils/`, `types/` and another feature's public `index.ts`.
  - It never imports `electron`, `node:*` or `main/platform/`; it reaches I/O only through `ctx`.
  - The router in `main/app/` derives channel names, request and response types, the preload bridge and validation from the definitions. Adding a call is one action file plus its renderer call site.
- **AppContext.** One object, built once in `main/app/`.
  - It holds the platform adapters (gh, git, fs, run, the Agent SDK, the clock, paths), every store and the repository registry.
  - The platform adapters are the only importers of `node:fs`, `node:child_process`, `fetch`, `electron-updater` and the Agent SDK.
  - There is no `*Deps` interface outside an adapter, and no factory that only pre-binds dependencies.
  - Tests build an in-memory AppContext. Fixture mode swaps adapters only.
- **JsonStore.** `createJsonStore({ file, version, schema, migrate })` is the only JSON persistence.
  - One file per store, a zod `schema`, a pure `migrate(fromVersion, raw)`, atomic writes through `ctx.fs`.
  - Each store states what a missing, malformed or newer-version file loads as, and which direction that fails toward (§4).
- **Transition.** A pure `(ticket, event) → ticket | refusal`, a typed table keyed on status × event, in its feature folder.
  - The commit compares `rev` and refuses a stale one. A transition is applied only once it is persisted.
  - It imports only `utils/` and its feature's types.
- **Domain table.** One `stages.ts` under `utils/` is the single source of stage, phase, column and needs-you kind for both processes.
  - Every derivation is a function of this table. Nothing outside it re-derives these values.
  - It imports only zod and `types/`.
- **Page.** `renderer/pages/<page>/` holds `page.tsx` (composition), `model.ts` (pure, no React and no data hooks), `copy.ts` (every string) and `components/` (local to the page).
  - It is built on `<Page>`, which owns the loading, error and empty states.
  - It reads data through the data layer's typed action hooks only.
- **Operator action.** Every write button goes through `useActionMutation(name, { confirm, toast, invalidates })`.
  - A confirmation is `<ConfirmDialog>`, never a hand-built dialog.
  - A typed `{ ok: false }` reply is data, shown to the operator. Only a rejected invoke is an error.
- **Zod.** Zod is the only schema library: action inputs, stores and the repository config.
  - Types come from `z.infer` and are never declared a second time.
  - The published config JSON Schema is generated from zod.

### Split rule

- §7's line limit is hard here as well.
- A file is split along a pattern boundary (one action, one store, one table, one page component), never by line count.
- A comment saying a file was split to stay under the limit fails review.

### Tests

- Pure decisions get table-driven tests.
- Flows get scenario tests through an in-memory AppContext, asserting the final state.
- Never write a test that pins UI copy, asserts mock call order, or reads source text.
- A ticket adds a test only when it adds or changes a decision.
- The guideline is test lines at about 10% of source lines. The enforcement is a branch-coverage gate on the pure pipeline modules.

### Checks

- No new `scripts/checks` module asserts on `apps/desktop` source text. Import, global and layering rules go in `apps/desktop/eslint.config.mjs`.
- Duplication is removed, not pinned: a shared value has one home that both processes import. A copy that cannot be avoided (bundled data) is pinned by a test or a type.
- The only checks that may name a desktop path are for the safety properties below.

### Safety properties

- Labels are a display mirror written after the ticket record commits, and no decision reads one.
- Only the write adapter writes to GitHub, and it never runs merge, close, `--delete-branch` or ready.
- The GitHub token stays in main-process memory.
- Main holds exactly one clock.
- A stall is a report, never proof. It is suppressed when its evidence is older than one poll plus grace.
- The renderer never sets HTML from text (no `innerHTML`, no `dangerouslySetInnerHTML`), and links are `http(s)` only.
- The renderer uses no `useEffect` or `useLayoutEffect`.
- Colour comes only from theme roles.
- Fixture data replaces adapters only, never the decision logic, and a release build carries none.
- Stage-session instructions come from the app's own `stage-prompts/` copy, and a stage session never writes a label.

### Desktop self-check

- [ ] Every call, store, transition, table, page and write button uses its pattern above.
- [ ] No file is over the limit, and none was split by line count.
- [ ] A test was added only for a decision that was added or changed.
- [ ] No new check asserts on `apps/desktop` source text.
- [ ] Every safety property above still holds.
