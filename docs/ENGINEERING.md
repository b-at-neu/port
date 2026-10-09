# Engineering Standards

Every pipeline agent reads this document before working. It defines the quality bar beyond what is obvious from the code. Plans must account for it per feature, implementations must follow it, and review findings may cite its sections the same way they cite the plan.

This is **this repository's own** standards document, not a template — `plugins/port/templates/ENGINEERING.template.md` is the skeleton `/port:init` installs elsewhere. Concrete paths like `plugins/port/**` are therefore correct here, and only here.

**Where things live is not this document's job.** [ARCHITECTURE.md](../ARCHITECTURE.md) is the canonical repository map and the authority on the ship boundary; it carries its own layer 1 pin (`scripts/checks.ts` → "Repository map covers the real tree, both directions"), so restating its table here would create a second copy with nothing pinning it — exactly what §2 forbids. This document covers *how* to write, not *where* to put it.

**Citations name checks and sections, never line numbers.** `scripts/checks.ts` and `docs/PIPELINE.md` are the two most-churned files in the repository, so a line reference in either is stale within days. Every citation below names a `// --- ` check block or a markdown heading, both of which survive edits and file splits.

**Stack:** Markdown agent and skill definitions (the product) · Node.js ESM scripts in TypeScript, type-stripped at load with zero runtime dependencies (static checks, artifact validation, worktree reclamation), at or above `package.json`'s `engines.node` floor · JSON Schema draft 2020-12 · GitHub Actions · `gh` CLI for all GitHub I/O · a pnpm workspace with TypeScript and Electron (`apps/desktop`)

## 1. Architecture

`plugins/port/docs/PIPELINE.md` is the single source of truth for operating rules, the label lifecycle, the permission model, and every output format. Every agent and skill references it and restates **only** what is unique to itself. A rule belonging to more than one stage goes there, not into each stage — and when it must appear in several files, it goes in as a byte-identical block with a pin (see §2).

### Rules

**Hook and script code separates pure decision logic from I/O.** `hooks/lib/guard-rules.mjs` exports pure functions unit-tested directly; `hooks/agent-guard.mjs` is the thin stdin/stdout/exit-code wrapper, tested separately by spawning the real script ("Guard hook classifier" and "Guard hook end-to-end wiring"). The same split applies to the worktree reclamation script ("Worktree reclamation classifier"). New logic goes in the library, not the wrapper — the wrapper's tests cannot see a classifier bug and the classifier's tests cannot see a wiring bug.

**Scripts follow one runnable entry point plus a shared library.** `scripts/checks.ts` is a runner that only wires — it discovers and imports every `scripts/checks/<topic>.ts` module from disk, awaits each in turn, then calls `report()`, with no assertions and no hand-maintained module list of its own. Each topic module exports a function taking the reporter, typed `Reporter` (`scripts/lib/report.ts`). A topic module asserts a single condition with `expect(cond, check, detail)`, reaching for `fail`/`ok` only when the logic genuinely branches — an `else if` chain, a loop that fails per item, or a block with a side effect. `scripts/lib/report.ts` is a deliberately dumb collector and printer, shared by layers 1 and 2, which "decides nothing" (its own header); `scripts/lib/files.ts` holds the file-system helpers (`root`, `readJson`, `walk`, `frontmatter`) the topic modules share. A new check goes into the topic module it belongs to, never into the runner — nearly every ticket adds a regression guard, so a runner that reabsorbed assertions directly would recreate the file-contention bottleneck the split exists to remove (`PIPELINE.md:95-114`). Source is type-stripped, never type-checked at runtime: `scripts/lib/errors.ts`'s `message(e: unknown): string` is the one helper every `catch` site imports rather than casting `e` by hand, and JSON read off disk (`readJson`) stays `any` — a port config's shape and defaults come from `schema/port.config.schema.json`, never a hand-transcribed TypeScript interface (§2's own rule, restated for `scripts/` specifically).

**The trajectory record is write-only from the tick engine's own decision path.** `scripts/port-tick/events.ts` (the emitter) exports no function whose name contains `read` or `parse`, and nothing under `scripts/port-tick/` besides `port-tick.ts` and `report.ts` itself may import `events.ts` or `report.ts` ("Write-only rail", `scripts/checks/tick-events.ts`) — an append-only history that fed a future tick's decision would quietly break `plan`'s own never-persists invariant (#203).

**A file that an adopting repository copies alone must be self-contained.** `plugins/port/bin/artifacts.mjs`, `bin/worktrees.mjs`, and `bin/budget.mjs` carry no relative imports, because an import resolving only inside this checkout breaks silently for every adopter while passing here — checked directory-wide, not per file ("bin/ holds only self-contained .mjs", `scripts/checks/layout.ts`). Cross-platform behaviour is part of the same contract — these run on an adopter's Windows machine, not just this one, which is why `bin/worktrees.mjs` and `bin/budget.mjs` also carry their own `execSync`/`shell: true` bans in `scripts/checks/cockpit.ts` and `scripts/checks/budget.ts`. This is also why §7's line limit exempts `bin/` instead of splitting it: the runner-plus-modules split every other over-limit file uses would break this same self-containment guarantee (#183).

**`plugins/port/` is one contract per directory (#171).** `templates/` holds only fill-in templates a `/port:init` or `/port:analyze` run substitutes into; `bin/` holds only self-contained executables copied verbatim into a managed repository, some of which this repository also runs in place; `data/` holds only canonical data — currently `labels.json` alone. `scripts/checks/layout.ts` pins all three, plus the absence of any tracked file still naming one of the three moved files under its old `templates/`-relative path.

**No repository-specific value is ever a literal in prompt text.** Label names, check names, branch names, and the repository slug are resolved from `.claude/port.config.json` or from PIPELINE.md's default table at read time. A literal label name silently matches nothing — `gh issue list --label <unknown>` exits 0 with an empty result — and a literal CI check name breaks the moment a repository renames its workflow job ("No config key appears as a literal --label argument", "Generality guard — no literal CI check name in a stage prompt"). The test to apply: **would this behave correctly in a freshly `/port:init`-ed repository with renamed labels, a single branch, and a different set of CI checks?**

**Anything shipped may only reference other shipped paths.** A reference from a file under `plugins/port/` to a repository-only doc or script — `docs/USAGE.md`, `CONTRIBUTING.md`, `scripts/checks.ts` — dangles in every adopter's plugin cache, which carries only `plugins/port/` (`scripts/checks.ts` → "Shipped references stay inside plugins/port/").

### Module boundaries

Sorted by path. Insert a new entry at its alphabetical slot, never at the end.

**`apps/desktop/electron-builder.config.mjs`**
- the packaging boundary, with `apps/desktop/scripts/`
- `bundle-audit.mjs` is pure — `node:` builtins only, no `node_modules` needed
- release version only from `release.versionFiles[0]`, never desktop's own `package.json`

**`apps/desktop/src/main/actions/`**
- only `applyLabels` caller across pause/resume/retry/gate/refresh/claim/escalate/observe/decide
- never trusts a renderer-supplied `expectedStage` to widen a write, only to refuse
- `gate.ts` comments before the label swap; `escalate.ts`/`observe.ts` swap first
- `decide.ts`'s `applyItemDecision` (#312) is the fifth comment-then-swap composition: check → re-read → comment → swap, `gateAnswer`'s own direction — pinned by `desktop-gate`/`desktop-actions`
- `gate.ts`'s `autoApprovePlan` (#313) posts no comment — the click's own label plan, with an `autoPlan`-present, exact-assignee precondition in place of the click's `{ kind: 'any' }`

**`apps/desktop/src/main/channels/<topic>.ts`**
- one topic's IPC validation and composition; `main/ipc.ts` stays the registrar
- a new channel follows the existing `*Deps` injectable-seam idiom — inject only real I/O (a subprocess, the filesystem, the SDK, a clock a test actually overrides), at the composition root; never a pure function (#350)
- `items.ts` (#312) holds `item:action` and `item:decide` — moved out of `main/ipc.ts` verbatim, the same split every other topic here already follows

**`apps/desktop/src/main/claim.ts`**
- the claim dialog's only composition root
- re-runs the preflight on apply; never trusts what the renderer already confirmed
- no `gh` import — reads via `./github`, writes via `./writes`

**`apps/desktop/src/main/dispatch/`**
- owns the per-repository run-state store (`Map<RepoId, RepoRunState>`) and the halt composition over it
- `dispatcher.ts` is the main-process stage-session loop's own composition root; reads `main/dispatch/ownership.ts`'s record for ownership, no hosted Claude session of its own
- launches go through `launch.ts`'s `StageLauncher` seam (#327 implements it); `launch: null` until then reports `no-launcher` rather than idling silently
- fires from `main/ipc.ts`'s `onTick:` only — a fresh poll, never `onSnapshot:`'s own republish, which would retrigger the loop off its own state change
- capacity comes from the hosted-session store (`launch.ts`'s `freeSlots`); launches across every repository are serialized into one promise chain so two repositories never race for a slot
- `ledger.record` only after a launch returns `ok`; the budget gate is the last veto before it
- `quit.ts` is the quit warning's own pure copy and guard; `main/dialogs.ts`'s `confirmQuit` is its one native dialog
- `auto-plan.ts`'s `createAutoPlanner` (#313, #331) is a snapshot consumer gated on this app owning the repository and on the per-repository run state the same way `dispatchableFrom` is; kept out of `dispatcher.ts`, since the two serve different callers

**`apps/desktop/src/main/fixtures/` is the visual harness's own adapter boundary (#317) — every screen read a fixture run serves comes from here, never from `main/github/`, `main/sessions/`, `main/local/`, or any other real adapter.** `mode.ts`'s `fixtureMode` is pure — `PORT_FIXTURES` must be exactly `'1'` in an unpackaged build, and a packaged build ignores the flag outright (`ignored`) rather than ever risking it reaching a real operator's install; an absolute `PORT_FIXTURES_USER_DATA` is required (`invalid` otherwise), since a fixture run against the real profile would take the operator's single-instance lock and write their theme preference. `main/index.ts` calls it before `requestSingleInstanceLock()`, and in `whenReady` calls `handlers/index.ts`'s `registerFixtureIpc()` in place of `registerIpc()` — no watcher, no hosted-session store, no drain store ever start. `fixtureMode` also parses `PORT_FIXTURES_SCENARIO` (`populated` by default, or `empty`), fails closed to `invalid` on anything else, and threads the result through `registerFixtureIpc` → `fixtureHandlers` → `fixtureBoardSnapshot`, so a screen ticket can capture its own empty state from the same adapter boundary rather than a second canned path. `handlers.ts`'s `FixtureHandlers` type is exhaustive over `IpcChannel`, so a channel added to `shared/ipc.ts` with no fixture fails `pnpm typecheck` here rather than crashing the one process an agent cannot see a stack trace from; every handler is pure, synchronous, and throws nothing, since a rejected invoke renders as an `ErrorBanner` and would misrepresent the screen under test. `board.ts`'s `fixtureBoardSnapshot` passes canned GitHub, session, worktree and denial reads through the real `reconcileRepository` (`main/state/reconcile`, never `main/state/watcher`) and `planTick` (`main/tick/plan`, alongside `main/tick/ledger`'s ledger/refresh-memo constructors), so a screenshot shows exactly what the real derivation produces — the fixtures replace the adapter boundary only, never the decision logic above it. A production file under this directory may import only `electron`, `node:path`, a sibling (`./*`), `shared/**`, `main/registry/schema`, `main/state/reconcile`, `main/tick/ledger`, or `main/tick/plan` — anything else would let fixture mode reach `gh` or `claude`, which the `desktop-visual` layer 1 check pins mechanically, alongside `main/index.ts` passing `app.isPackaged` to `fixtureMode(`, every `router.tsx` route path staying one of `ROUTE_IDS.<key>`/`'/'`/`'*'`, and `commands.checks` never naming `screenshots` (that list runs on every dispatched agent, and this command launches Electron).

**`apps/desktop/src/main/hosting/`**
- owns a hosted session's full lifecycle (#98); the renderer only sends intents (eight `session:*` channels) and receives events, never drives the child directly. #326 removes the dispatcher role: no `SessionOptionsRole`, no per-session task tracker, no `allowedTools`
- `project.ts`'s `createSessionProjector` (#219) reuses `createDeriver` for the same `TranscriptEntry` shape `main/sessions/` derives on disk, rather than a second `tool_use`/`tool_result` pairing (#123); `session:attach` replays its bounded window so a reload rebuilds from the same state a mid-stream push already describes
- streaming input only, always: `input.ts`'s push-driven `AsyncIterable<SDKUserMessage>` keeps `interrupt()`/`setPermissionMode()` available for the handle's whole life — a string prompt would silently disable both
- `sdk.ts` is the third lazy Agent SDK seam (alongside `sessions/sdk.ts` #78, `runtime/sdk.ts` #97), the only file here naming the package specifier
- `permissions.ts`'s per-session broker (#99) turns every `canUseTool` call into a pending request on the handle's own snapshot; `grant.ts` narrows the SDK's suggestions to an allowlist of three, and a grant never writes `settings.local.json`/`settings.json`
- `persist.ts`'s `createHostingPersistence` (#103) is `hosting.json`'s only writer; a missing or malformed file resolves to an empty state rather than refusing to load, and `freeze()` — called before `closeAll()` closes any handle — drops every later save
- `store.ts`'s `Map<sessionKey, Handle>` is bounded by an operator-settable, persisted session limit; `start()`'s already-open refusal fails closed on a live `sessionId`, since two `claude` processes must never append to one transcript
- `plugin.ts`'s `resolvePluginRequest` (#101) prefers the repository's own `plugins/port/` over the installed cache, and fails loud — an unreadable manifest still resolves to `repository`, never a silent fallback
- `capabilities.ts`'s per-session tracker races `supportedCommands()`/`supportedAgents()` against a timeout, going `unavailable` rather than ever reading either as an empty list
- an operator's own session defaults (`options.ts`'s `defaults` param) apply only to an operator-role start — the dispatcher role always keeps its own `model` and `permissionMode: 'default'`, never bypass/dontAsk/auto

**`apps/desktop/src/main/local/`**
- only reader of worktrees and the denial log
- no `gh`; no item-state resolution

**`apps/desktop/src/main/platform/`**
- only importer of `node:child_process` / `node:fs` under `apps/desktop/src/`
- spawnables a literal union (`KNOWN_COMMANDS`); paths via `pathKey`/`contains`, never `startsWith`

**`apps/desktop/src/main/reclaimer/`**
- drives the shipped `worktrees.mjs` script; never re-implements its classification
- calls no `git worktree` itself; only `node` is spawnable here
- may run `reclaim` (never `--unlock`/`--force-dirty`); every attempt is audited via `main/writes/audit.ts`'s `appendAudit`, from `main/channels/worktrees.ts` — this directory itself never writes the audit log

**`apps/desktop/src/main/registry/effective.ts`**
- resolves effective config: `CLAUDE.md` overrides folded over port-resolved values
- fails closed (`effective-config-unreadable`) rather than silently running on port defaults
- imports `scripts/port-tick/overrides.ts` directly — no app-owned copy

**`apps/desktop/src/main/registry/schema.ts`**
- the only reader of `schema/port.config.schema.json`'s shape and defaults
- never a hand-transcribed TypeScript interface of the config shape

**`apps/desktop/src/main/relay/`**
- detects an agent waiting on a human from transcripts; computes, never sends
- markers anchored at line start, outside code — a quote never misclassifies as pending
- the one Electron clipboard write; the operator still pastes the reply themselves

**`apps/desktop/src/main/runtime/`**
- the SDK runtime adapter's composition root: locate → version → credentials → classify
- `main/ipc.ts` calls only `runtimePreflight`/`runtimeProbe`, never resolves the registry itself

**`apps/desktop/src/main/tick/`**
- `RepositoryState` → `TickReport`; computes, never writes
- imports `scripts/port-tick/`'s own decision modules directly, checked against shared case tables
- blind read → no actionable, held or claim counts at all
- `auto-plan.ts`'s `autoApprovalsOf` (#313) ignores `sessionRequired` deliberately — the cockpit's own rule is that the swap still happens; `dispatchable.ts`'s `autoApprovableFrom` is the only reader of `.autoApprovals` under `main/`

**`apps/desktop/src/main/trajectory/`**
- the one write `main/tick/` itself never makes — computes there, writes here
- appends to `.agents/desktop-events.jsonl`; every failure swallowed, never surfaced
- called fire-and-forget from the watcher, never awaited

**`apps/desktop/src/main/writes/`**
- only GitHub writer; only `command.ts` names `--add-label`/`--remove-label`
- never `merge`, `close`, `--delete-branch`, or `ready`

**`apps/desktop/src/renderer/src/components/conversation-model.ts`/`conversation-list.tsx`**
- the one `TranscriptEntry` → view-model mapping and the one pin-to-bottom, chunked-reveal list
- shared by the on-disk transcript view and the live session view, never a second copy
- no `useEffect`: `conversation-list.tsx`'s scroll-pin and chunking both run from a plain ref callback, given a fresh function identity every render so React re-invokes it on each commit

**`apps/desktop/src/renderer/src/data/`**
- the renderer's one TanStack Query composition root
- `data/subscriptions.ts` is the only caller of a `window.port.on*` push listener
- a typed `{ ok: false }` response is data, not an error — only a rejected invoke is
- `session:status` upserts the `session:list` cache by `sessionKey` when it already holds an entry and nothing is mid-fetch; otherwise it invalidates

**`apps/desktop/src/renderer/src/needs-you/`**
- the Needs you screen (#315): its own copy (`copy.ts`), action resolution and dispatch (`actions.ts`), and the relay compose form (`relay-form.tsx`), ported out of `board/relay.ts`'s former banner
- `screen.tsx` reads `board:snapshot` through `shared/board/needs-you.ts`'s `needsYouItems`, never a second derivation; writes go through the existing `item:action`/`item:decide` channels, no new IPC
- `components/needs-you-item.tsx` is the shared row (DESIGN §4's `NeedsYouItem`); a screen never builds its own version

**`apps/desktop/src/renderer/src/session/`**
- `entries-store.ts`'s `createEntriesRegistry` is the per-`sessionKey` attach/re-attach/buffering registry — injectable for its own tests, a thin app-wide singleton for `useSessionEntries`
- `sequence.ts`'s `accept`/`drainBuffered` apply a `session:entries` delta only in revision order, never papering over a gap
- `actions.ts` is the one place that writes the `session:list` query cache outside `data/subscriptions.ts`'s own push wiring — `adoptSession` after a start or a restore
- `drafts.ts` keeps a composer draft per `sessionKey` outside React, so switching sessions and back never loses what was half-typed

**`apps/desktop/src/renderer/src/shell/`**
- the one React root: `layout.tsx`'s `ShellLayout` renders the sidebar and the routed `<Outlet/>` directly into the main area — no portal, no legacy container
- `keyboard.ts` installs one module-level listener, never `useEffect`
- `prefs.ts` fails toward defaults on a malformed `localStorage` value, never throws
- `lib/phase.ts`'s `PHASE_NAMES` and `key-bindings.ts`'s `KEY_BINDINGS` are pinned against `docs/DESIGN.md` §6 and §3 by the `desktop-shell` check, both directions

**`apps/desktop/src/shared/local/inspect.ts`**
- the app's only aggregation of the denial log; pure, reader-free
- `main/local/` stays the single-source adapter it joins

**`apps/desktop/src/shared/markdown/`**
- pure, bounded-subset markdown parser — no `node:` import, nothing from `main/`
- link scheme allowlist is `http://`/`https://` only; everything else renders as literal text
- `renderer/src/components/markdown.tsx` is its only consumer; renders React elements, never `dangerouslySetInnerHTML`

## 2. Data and integrity

`.claude/port.config.json` validates against `schema/port.config.schema.json` (draft 2020-12). Fixtures come in pairs — `schema/fixtures/valid.*.json` must validate and `invalid.*.json` must be rejected — and both directions are asserted, because a fixture set that only proves acceptance proves nothing ("Schema fixtures still discriminate", plus the `run-schema-fixtures` CI job which does the full validation layer 1 deliberately cannot).

**Any content duplicated across files gets a mechanical assertion pinning the copies together, in both directions — never a "keep in sync" comment.** This is the repository's most consistently applied rule.

**If a change introduces a further copy of anything, it introduces its pin in the same commit.** A comment asking a future reader to remember is not a pin.

**Config shape is asserted, not assumed.** `commands.checks` entries must be `{run, fix}` objects: a bare string is still valid JSON and reads plausibly while every consumer reading `entry.run` gets `undefined` ("The config template matches its own schema's shape").

## 3. Security

**Broad allow, authoritative deny.** The allowlist grants whole development-command categories; the deny list is the real safety surface for dangerous or interactive commands, and deny beats allow at every scope. Any permission change is reflected in both `templates/permissions.base.json` and PIPELINE.md's permission model section.

**The `PreToolUse` guard hook is the enforcement.** `permissionMode: dontAsk` in agent frontmatter stays as declared intent and a second line of defence, but has never been observed denying anything on its own (PIPELINE.md → "Why background dispatch needs care"). When a denial matters, the hook is what must change and what must be tested.

**The guard's rails are not subagent-only.** Two apply to any caller including the cockpit's own session, because the cockpit violated them under throughput pressure: no `gh`/`git` inside a shell loop, and no clearing `<labels.needsHuman>` unless a recent operator message names that item. A third denies plugin install or marketplace mutation from inside any worktree, since every scope resolves to the same on-disk `installPath` and would silently repoint every session on the machine.

**`sessionRequiredPaths` is a harness-level boundary no dispatched subagent can cross, and settings cannot grant it back.** A plan writing under those paths routes to `/port:implement` in an operator session; it is never worked around.

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

**An absent signal is never read as a passing one.** An empty check rollup is pending, not green; a check with no conclusion has not passed. No verdict is formed while any check on the head commit is pending, or on a pull request GitHub reports `CONFLICTING`. Liveness is a `TaskList` call, never inferred from a label — an in-flight label means a stage *claimed* an item, never that anything is still running ("Liveness is a TaskList call, never a label inference"). The same rule holds for a GraphQL fetch: a non-zero `gh api graphql` exit is not evidence of no data — `gh` exits non-zero whenever the response carries `errors`, even when `data` is still usable, so the envelope is always parsed in full rather than trusted or discarded by exit code alone. Only the aliases actually named in `errors[].path` are treated as unavailable; every other alias in the same response is trustworthy. A GraphQL call is never filtered with `--jq`, since `gh` silently skips that filter on exactly the partial-error response this rule exists to read, and no code path returns an empty result set for a request that did not actually succeed (`desktop-github-adapter`).

**A denial log's line count is never presented as a denial count, and an unresolvable session id fails toward `unknown-session` rather than a guessed role** — the log's line total conflates real denials with allowlist misses and rail holds, and a wrong attribution is unrecoverable misinformation an operator would act on; both are pinned by the `desktop-local` check.

**A local transcript's recency is activity, never liveness.** Nothing readable from a file on disk proves a process is running — a crashed agent's transcript looks identical to a live one's, only older. `apps/desktop`'s session adapter therefore reports `lastActivityAt`/`activity`, never a `running`/`alive`/`isLive`-shaped field, and leaves "stalled" to a reconciliation that also holds the labels — the `desktop-sessions` check pins the absence mechanically. That reconciliation (`main/state/`) may report a stall, but a stall is a **report, never a proof** — `TaskList` remains the only real liveness evidence, and a session read that could not run never produces one, since a check that could not run is not a check that found nothing — the `desktop-state` check pins the same absence for the module that consumes it. **A stall is additionally suppressed when the evidence behind it is older than the poll that produced it** (#80 Decision 5): `shared/board/project.ts`'s `displayStatus` renders `stalled` as `stalled` only when the repository's GitHub source is healthy and its last read is within one poll interval plus a fixed grace window of `now`; otherwise it renders `in-flight`, qualified with the read's age. This fails toward under-reporting — a phantom stall costs one more glance, but training an operator to distrust the one signal this app differentiates on costs the whole feature. The app holds exactly one clock, in `main/state/watcher.ts` — the `desktop-board` check pins both the suppression's key set and the single-timer rail.

**A path is not evidence.** Reporting a derived fact means resolving it, not pattern-matching a string that correlates with it: the running-plugin tell resolves the install record's commit sha rather than printing a cache path, because the path-based version reported "stale" every time under a directory source ("Running-plugin staleness is resolved, not printed from a path").

**Large or fenced markdown never goes inline to `gh`.** Write the payload under `.temp/` and pass `--body-file` or `--input`; shell quoting of backticks and code fences fails cross-platform.

## 5. Accessibility

Narrow but real, because the pipeline's whole visible state is a set of GitHub labels.

**Label colour encodes role by hue and position by lightness.** Triggers blue, in-flight amber, gates red, terminal green, each an ordered Primer ramp in pipeline order, so position within a role is legible from colour alone. Gates step two shades at a time rather than one, "so severity reads from a large lightness delta rather than hue alone — legible under red-green colour vision deficiency" (`labels.json`'s own `$comment`). Every colour is a well-formed six-digit uppercase hex and no two labels share one ("Label colours are well-formed and distinct").

**Severity is never colour-only.** Review findings carry both an emoji and the word: 🔴 Critical · 🟠 Medium · 🟡 Low · ⚪ Nit.

**The desktop app's screens meet WCAG AA**, built to `docs/DESIGN.md`:
- Text contrasts at least 4.5:1 with its background, and focus rings and status dots at least 3:1. `DESIGN.md` §1 records what each token pairing measures and the two rules that follow from the failing ones.
- Status is never colour-only: every pill and phase carries its name in text, and the phase bar has a tooltip.
- Every action is reachable by keyboard, with a visible focus ring. An icon-only button has both a tooltip and an accessible name.
- No text is smaller than 11px, and no click target is smaller than 24px.
- The OS reduce-motion setting turns off every transition and the attention pulse.

## 6. Performance

**Cost is measured, then reduced, then pinned.** The polling tick collapsed from roughly 15 GitHub round trips to one aliased `gh api graphql --include` call at a measured ~12 points against the 5,000/hour budget, and layer 1 now fails if a per-label poll creeps back under the Tick procedure heading ("Collapsed tick query — one round trip, never a per-label poll").

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

**Every fixed regression leaves a mechanical guard behind, and duplicated content leaves a mechanical pin behind.** Layer 1 pins the literal phrase or contract that constituted the fix, so a future edit quietly reverting the reasoning fails in CI rather than in a live pipeline run. A prose-only fix to a prompt is incomplete. A duplicated copy gets the same treatment: a check that asserts the two sides agree.

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
- [ ] A fixed regression leaves a layer 1 guard behind.
- [ ] A new rail is a checkable precondition, not "never do X" prose.
- [ ] Any new failure mode states which direction it fails toward, and why.
- [ ] An absent signal is not treated as a passing one — no empty rollup, missing conclusion, or exit code read as success.
- [ ] A derived fact is resolved, not inferred from a path or a label.
- [ ] A file an adopter copies alone has no relative imports and works on Windows.
- [ ] No inline `--body "..."` carrying markdown or fences — written under `.temp/` and passed as `--body-file`.
- [ ] New paths are reflected in `ARCHITECTURE.md`, and shipped files reference only shipped paths.
- [ ] Every comment added is one line, explains a constraint or an unusual why, and cites no ticket number.
- [ ] `node scripts/checks.ts` passes locally before pushing.
- [ ] `pnpm typecheck:scripts` passes, and no new file crosses the `noUncheckedIndexedAccess`/`erasableSyntaxOnly` boundary `tsconfig.scripts.json` sets for `scripts/`.
- [ ] No file under `plugins/port/` carries a `.ts` extension — type stripping needs the Node floor `package.json`'s `engines.node` sets, which an adopter never agreed to.
- [ ] Commit subjects are `#<issue> <imperative lowercase>`, under 80 characters, no trailing period.
- [ ] No file crossed the line limit, and no allowlisted file grew.
