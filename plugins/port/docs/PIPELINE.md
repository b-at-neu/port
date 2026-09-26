# Agent Pipeline

This plugin takes GitHub issues from idea to merge-ready pull request with minimal human intervention. A `/port:pipeline` session is the human's cockpit: it polls GitHub, dispatches background stage subagents, relays their questions, and applies every label. Humans converse; they never run `gh` commands. Each operator runs their own cockpit, and every query is scoped to that operator's assigned items (see "Multi-operator partitioning"). GitHub labels remain the durable state machine, so progress is always visible on GitHub and manual intervention always works.

**This document is the single source of truth for the operating rules, label lifecycle, permission model, and output formats.** Every stage agent reads it before working and restates only the rules unique to itself.

Agents and skills reference it as `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md`, which resolves to the plugin's installed location. Other plugin paths below (`agents/`, `skills/`, `templates/`, `bin/`, `data/`) are relative to that same root.

**Companions**, read alongside this hub, in the same `docs/` directory:

| File | Holds |
| --- | --- |
| `FORMATS.md` | Output formats — writing style, the implementation plan, reviews and revisions, approval withdrawn, rebase required, the pull request description, commit messages |
| `RECOVERY.md` | Escalation, Liveness, the Rebase conflict protocol, Stopping and draining, the Recovery runbook, reading current state without the cockpit |

## Configuration

Everything repository-specific lives in `.claude/port.config.json`, committed alongside the repository’s Claude settings, so it is reviewable in pull requests. Field reference: the `$schema` URL that `templates/port.config.json` already carries.

**How each agent reads it depends on its worktree.** `plan-agent` and `review-agent` run without `isolation: worktree`, so `.claude/port.config.json` is on disk and they read it with the Read tool. `impl-agent` and `revise-agent` run under `isolation: worktree`, whose initial checkout is **not trustworthy** — confirmed by direct inspection, it can land on an unrelated, stale ref (`origin/main`, pinned to a commit predating this repository's `.claude/` directory) rather than the repository's actual default branch, regardless of what `branches.integration` says. Reading local `HEAD` there fails exactly like a missing file. Both agents instead resolve the remote's real default branch live (`git remote set-head origin --auto`), fetch it, and read `git show origin/HEAD:.claude/port.config.json` — the committed blob out of the object store, independent of whatever the worktree happened to check out. `/port:implement`'s own worktrees are a full `git worktree add … origin/<integration>` and do carry `.claude/` on disk, so that skill's session reads it with the Read tool as usual.

**This means the repository's default branch must itself carry a current `.claude/port.config.json`.** It is the only ref `impl-agent` and `revise-agent` can resolve before they have read any config at all — they cannot ask `branches.integration` which branch to read, because that field lives in the config they have not read yet. The practical consequence: a config change merged only to `<integration>` does not reach these two agents until it also reaches the default branch, whether directly or through the repository's normal release flow — in a single-branch repository (`<production>` null) the default branch **is** `<integration>`, so that lag collapses to zero. A repository whose default branch lacks `.claude/port.config.json` entirely is reported as unmanaged, and dispatch halts.

Throughout this document:

| Placeholder | Means |
| --- | --- |
| `<repo>` | `repo` — the `owner/name` every `gh` call is scoped to |
| `<integration>` | `branches.integration` — what feature pull requests target |
| `<production>` | `branches.production` — what releases promote to; null in a single-branch repository, where there is no release flow |

Label names are written as their defaults (`ready`, `plan review`, …). A repository may rename any of them through `labels`, in which case the renamed string is what agents read and write.

**One section is an optional subsystem**, marked at its heading and inert when its flag is false: "CI merge gate" (`modules.approvalGate`). When the module is off, its labels are never created, its queries never run, and the agents carry no instructions about it.

## Quick start

```
claude          # open a session (haiku recommended for the cockpit)
/port:pipeline  # start the cockpit
```

Then talk to it: `work on #142` · `scope out a notifications feature` · `status` · `pause #142` · `retry #142` · `unblock #142` · `drain` · `resume` · `stop #142`.

## The flows

### Major feature

| Step | You (in the cockpit) | Behind the scenes |
| --- | --- | --- |
| 1. Describe | "scope out X" — short conversation | `/port:scope` creates the epic and sub-tickets, linked and dependency-ordered |
| 2. Start | "work on #N" + choose: review the plan, or auto-approve | `plan-agent` researches the codebase and writes a plan into the issue; its questions pop up in your terminal |
| 3. Approve plan | Read the summary, approve — or give feedback (it revises and comes back) | `impl-agent` builds in an isolated worktree, runs the checks, opens a pull request; `review-agent`/`revise-agent` loop until clean |
| 4. Merge | Click merge on GitHub | Issue closes automatically |

### Session-required ticket

Same as above through step 3, then it diverges: some tickets cannot be handed to an agent at all, because the harness denies a subagent's edits under the paths in `sessionRequiredPaths`. Their plan carries a **`SESSION REQUIRED`** marker, and at step 3 the cockpit **announces instead of dispatching** — it hands you a launch command and you run **`/port:implement <n>` in a separate session**. Nothing moves until you do; no agent will ever pick it up. Review and merge are unchanged. Full detail: "Session-required tickets".

### Bug fix

File the issue, then in the cockpit: "work on #N, auto-approve the plan", wait, merge on GitHub. The plan gate is skipped (`auto plan`); the merge gate never is.

## Architecture

- **Cockpit** (`/port:pipeline`, a skill) runs in the human's interactive session. It owns the conversation, the human gates (`AskUserQuestion`), and the wakeup schedule (`ScheduleWakeup`) — tools that only exist in a main session, not a subagent.
- **Stage workers** are **subagents** in the plugin's `agents/` directory (`plan-agent`, `impl-agent`, `review-agent`, `revise-agent`). Each carries its own tool scope, `permissionMode`, `maxTurns`, and (for the two that write code) `isolation: worktree` in its frontmatter. The cockpit dispatches by `subagent_type` and sets nothing else at the call site — **except the model**.

**Why the model is the exception.** Agent frontmatter is static, so an agent file cannot read `models` from a repository's config. Each agent therefore declares the recommended default in its frontmatter, and the cockpit passes `model` at the `Agent()` call site when the repository's config asks for something else, which takes precedence over frontmatter. So `models` is honoured, and an agent run by hand without the cockpit still gets a sensible model rather than none.
- **`impl-agent` and `revise-agent` get their own isolated git worktree** — a fresh checkout where they run `commands.bootstrap`, do the work, and push a feature branch. impl rebases onto `<integration>` and opens its pull request with `--base <integration>`; **revise rebases onto the pull request's own base branch** (`baseRefName`, never an assumed branch), autonomously resolving structurally unambiguous conflicts and escalating only ambiguous ones (see `RECOVERY.md` → "Rebase conflict protocol"). No manual `git worktree`, symlinks, or environment files are involved.
- **`plan-agent` and `review-agent` are read-only on source** (`disallowedTools: Edit`); they only read code and write to GitHub via `gh`.

### Multi-operator partitioning

Ownership is the second dimension of pipeline state: **labels say what stage an item is in, the GitHub assignee says whose cockpit owns it.** Every cockpit tick query is filtered to `--assignee "@me"` (issues and pull requests alike), and `impl-agent` copies the issue's assignee onto the pull request it opens, so an item stays inside one operator's view for its whole life. The invariant:

- **One cockpit per person, disjoint assignee sets.** Without the filter, every cockpit sees every item — operator B's terminal pops the plan gate for operator A's ticket, and B's approval is authoritative.
- **Exactly one assignee per in-flight pipeline item.** Two assignees means two cockpits both dispatch for it. Nothing enforces this; the cockpit's take-over flow (`work on #N` on someone else's ticket asks Take over / Cancel) is the whole mitigation.
- `@me` resolves to that session's `gh auth` account, so **two operators sharing a machine account silently restores the unpartitioned behaviour.**
- **An unassigned pipeline item is invisible to every cockpit.** The failure mode shifts rather than vanishing — pre-filter a ticket was seen by too many cockpits, post-filter an unowned one is seen by none. Each tick therefore runs an **unowned sweep** (one issue query, one pull request query, `no:assignee` narrowed by `--jq` to trigger and gate labels) and reports the set when it changes, without ever acting on it. `/port:scope` leaves backlog tickets unassigned by design — opt-in (`work on #N`) is what claims them, and it assigns as well as labels.

The **double-dispatch race is known and unfixed**: the trigger-to-in-flight label swap happens inside the agent after spawn, so a check-then-act window of tens of seconds remains. Disjoint assignee sets avoid it in practice; closing it properly means moving the swap into the cockpit, before the `Agent()` call.

### The tick's cost and clock

A tick used to cost ~15 GitHub round trips — one `gh issue list`/`gh pr list` per label, plus per-item follow-ups for mergeability, reviews, and check rollups — most of it pure polling against sets that overlap heavily (the unowned sweep re-fetched items the trigger queries had already returned). **The tick collapses to one `gh api graphql --include` call**, one aliased query per set the tick needs (`skills/pipeline/SKILL.md` → "Tick procedure" names every alias), at a measured cost of **~12 points against the 5,000/hour budget** — headroom is not a constraint at any pacing rung.

**Failure and truncation are fail-closed on actions, never on reporting.** `gh api graphql` exits non-zero whenever GraphQL's `errors` array is present, even when `data` is still usable — exit status alone must never be read as "the tick learned nothing":

- `errors` present, `data` usable → only the aliases named in `errors[].path` are unavailable; every other alias in the same response is trustworthy.
- No `data` at all, or the call errors with no parseable JSON → a **blind tick**: dispatch nothing, run no hygiene, reset nothing, and never claim "all clear" — but still schedule the next wakeup, at the pacing floor.
- A connection's `totalCount` exceeds its `nodes` length → that set is **truncated, not complete**: act on what came back, never report the stage as empty.

**Ownership moved from the query to the response.** Dropping the per-alias assignee filter is what makes the unowned sweep derivable from the same call rather than a second round trip — every issue and pull-request node now carries `assignees`, and the cockpit partitions client-side against `viewer.login`. The rail itself is unchanged: **an item whose assignees do not include the viewer is never acted on, only reported.**

**The clock is the `Date:` response header**, read via `--include` on the same call. GitHub's GraphQL schema exposes no server time, and no allowlisted command emits one, so this is the only authoritative "now" the session has — at negligible extra cost (~25 header lines), which the collapse from ~15 calls to 1 more than pays for. It is what makes the resume line possible: a session that stalled or was closed compares this tick's header against the last one it recorded and, on a material overshoot, treats the tick as changed rather than silently assuming nothing happened while it was gone.

**`.temp/tick-state.md` is the memory the collapse needs and the old per-tick queries never did.** One artifact, rewritten whole each tick, carrying: the clock (`Last tick`, `Scheduled`), the pacing ladder's own state (`Cadence step`, `No-change ticks`), the denial log's read offset (`Denials consumed`), and the three change-only reports' remembered sets (`Announced approved`, `Unowned reported`, `Ungated reported`, `Worktrees reported`, `Uncorrelatable announced`). Gitignored, and — like `.temp/dispatch-log.md` — a `Repo` header naming a different repository is treated as absent, never trusted.

**The pacing ladder replaces a two-speed rule that measured as one speed.** The old rule was binary — any agent in flight or item mid-pipeline polls every 270s, fully idle polls every 1500s — and in a 27-tick, 25-hour observed run, 26 of 27 wakeups landed at 270s: a tick with one long `review-agent` in flight polled every 4.5 minutes waiting for a completion notification that arrives on its own regardless, because background-agent completions wake the session between scheduled ticks. The fix separates two different questions the old rule conflated: *is something running* (irrelevant to polling need, since completions are event-driven) and *will anything move without a human* (the real reason to poll fast). **The ladder: floor 270s with no backoff whenever something will move on its own; otherwise back off one rung per consecutive no-change tick, 270 → 540 → 1080 → 1800, resetting to the floor on any observed change.** An hour-of-quiet shutoff was considered and explicitly rejected: **the cockpit must never stop scheduling wakeups on its own** — it is the only dispatcher, and a `ready` label applied while it is silent would never be picked up. The cost: worst-case pickup latency for a human label change rises from 4.5 to 30 minutes, and only in the fully-idle, fully-backed-off state — the ladder only backs off once nothing can move without a human, and the first observed change resets it to the floor, so the delay is bounded by how long the operator was away rather than by the pipeline's own state.

### Tick engine

The tick's *decisions* — query build, envelope classification, ownership partition, label classification, mergeability/contention/cycle-cap/liveness routing, and the pacing ladder — are, by default, hundreds of lines of prose executed by a language model: expensive, non-deterministic, and untestable. `commands.tick` (a `string | null` config field, default `null`) names a deterministic engine, addressed the same way `commands.worktrees` and `commands.artifacts` already are, that computes the same decisions as a script instead — repository-local tooling, not something `/port:init` installs. **The boundary, stated literally:** script handles GraphQL query and parsing · envelope classification · ownership partition · label classification · mergeability routing · contention overlap · cycle-cap counting · the liveness diff against the dispatch log · the pacing ladder · dispatch-log read/write; the model handles agent dispatch (the `Agent()` calls themselves) · the `TaskList` call · human gates (`AskUserQuestion`) · relay · intent interpretation (`work on #N`, `drain`, `dispatch #158 anyway`) · worktree/denial/unowned/ungated/plugin-staleness hygiene, which stays prose regardless of `commands.tick` — a bounded first slice.

**The script never writes.** It emits `writes` — exact `gh` command strings and `Agent()` call specs — and the model executes them verbatim; the script's own GitHub access is one read-only `gh api graphql` call, mechanically enforced by its own layer 1 check, so every existing rail's subject (the `needsHuman` gate rule, the loop rule, the `.agents/denials.log` audit) stays unchanged — the model, never the script, is still the one issuing every command. **The model executes the plan verbatim — a rail, not a suggestion:** the script's `commit` step rejects a tick identifier that does not match the plan this session just ran, which is what makes "the model actually ran the script this tick" checkable after the fact rather than merely claimed; `commands.tick: null` (every adopter until this ships more broadly) keeps the prose cockpit, moved byte-identical to `skills/pipeline/TICK-PROSE.md`. **The engine's decision-case tables** — one file per family (envelope, ownership, classify, contention, gates, liveness, pacing, writes), pinned per `ENGINEERING.md` §2 the same shape the worktree reclaimer's own correlation logic is pinned against its desktop counterpart — are the authoritative record of its behaviour: a second implementation is asserted against them, not reimplemented and hand-verified against this one's.

### File contention

Concurrency is otherwise correct and desirable — the account's usage window is time-based, not concurrency-based, so more agents running inside one window is strictly better. The one thing dispatch must never do is start two plans that write the same file at the same time: whichever pull request merges first invalidates the other's rebase, and the loser escalates to `<labels.needsHuman>` on a conflict a human never needed to see, because the information to prevent it — each plan's own `## Changes` file list — was sitting in the issue body unread.

**The occupied set.** Before dispatching `impl-agent` (step 4 of the tick), build the union of every in-flight item's claimed files, excluding any path in `concurrency.sharedFiles`: every `<labels.inProgress>` issue's `## Changes` block, plus every open `<labels.prOpened>` issue's — an **open** issue at that label is exactly "a pull request exists for it and has not merged," so it is the whole unmerged-branch set without a second query for pull request state. A `sharedFiles` path is still **claimed** by the plan that lists it, only ever **contended**: it never contributes to a hold, in either direction.

**The gate.** A `<labels.planApproved>` candidate holds only when one in-flight item's plan claims `concurrency.overlapThreshold` or more of the candidate's non-`sharedFiles` paths, counted per in-flight item, never pooled — reported every tick with the conflicting item, the contended paths, and their count, never silently skipped (a silent hold is the same invisibility #67's orphaned worktree taught this project to avoid). It dispatches automatically once the conflicting item's pull request merges or closes; no operator action required. Candidates below the threshold, once `sharedFiles` is excluded, dispatch freely, so throughput for genuinely independent work is unchanged. The predicate **fails open toward dispatch**: a false hold costs throughput on every ticket behind it, silently, and its cost compounds with how many tickets are in flight, while a false dispatch costs one rebase that usually resolves as a union and escalates by name when it does not — the two outcomes are not symmetric.

**Fewest-conflicts-first.** Sort the surviving (non-held) candidates ascending by how many *other survivors* they overlap at or above `concurrency.overlapThreshold` after excluding `sharedFiles`, and dispatch in that order, adding each dispatched candidate's claimed files to the occupied set as you go — so a ticket touching one contended file is not stuck behind one touching five, and a later survivor that now overlaps an earlier one's freshly-claimed files at or above the threshold is held this same tick.

**Fail-open on an unstructured plan.** A plan with no `## Changes` file block (typically one written before this contract landed) dispatches **unchecked**, with a one-line warning — silently holding every unstructured plan would stall the pipeline harder than the collision this section exists to prevent. **The gate applies to `impl-agent` dispatch only** — `plan-agent` and `review-agent` are read-only, so they claim nothing, and a `revise-agent` dispatch is for a branch that already exists and rebases itself on its own turn, so holding it would stall an already-open pull request rather than prevent a new collision.

**The hold is derived every tick, never stored.** It is recomputed from live labels and plan bodies on every pass, so it cannot go stale and cannot strand an item the way an ad-hoc hold once did. Two alternatives were considered and rejected:

- **A `held` label** — a new vocabulary entry no already-`/port:init`-ed repository has until re-run, and a second place the truth lives that can strand an item exactly as an unreleased ad-hoc hold once did.
- **GitHub's native `blockedBy` graph** — issue-to-issue only, and it would overwrite the real dependency record `/port:scope` writes with a transient scheduling fact.

**The decision, stated literally: a hold is derived every tick from live labels and plan bodies, never a new label and never GitHub's dependency graph.** A `<labels.planApproved>` item dispatches only when no single in-flight item's plan claims `concurrency.overlapThreshold` or more of the same non-shared files.

### Worktree lifecycle

A worktree is created by the harness (`agent-<hash>`, for a dispatched stage) or by `/port:implement` (`impl-<n>`, for a session-required ticket) — never by the cockpit itself, which only ever reads and reclaims. #62 established that per-tick removal was announced but never actually performed; the fix (#144) moves reclamation into a shipped script, `bin/worktrees.mjs`, addressed through `commands.worktrees` — one deterministic call whose stdout *is* the report, rather than prose aimed at the cockpit's own model. **Reclaimed automatically, no confirmation needed:** a worktree whose correlated issue or pull request is closed or merged (`done`), or whose `HEAD` holds nothing not already on the integration branch (`no-work` — the residue no correlation rung can name, but safe to reclaim regardless, since nothing would be lost). The cockpit runs this at startup (reconciling anything accumulated while it was not running) and every tick — both the general sweep, capped per tick, and a targeted `--issue <n>` reclaim the moment that item's pull request is confirmed merged or closed, so the acceptance criterion is "the same tick that reconciles the merge removes it," not "eventually."

**Reported, never force-removed automatically:** `locked` (a deliberate statement by a human or the harness — the report names the exact unlock command, never auto-unlocked), `dirty` (uncommitted changes a force-remove would destroy), and `unresolved` (no correlation rung resolved a number, and `HEAD` is not an ancestor of the integration branch — never guessed as either done or safe). `/port:worktree-clean` is the interactive front end for exactly these three, plus force-deleting an `orphan-dir` — an untracked directory beside a registered worktree, which the script never deletes on its own.

**Correlation, first hit wins:** the branch's upstream (`branch.<B>.merge`, written by `git push -u`), the branch name (`^(\d+)-`), the directory basename (`^impl-(\d+)$`), or the `HEAD` commit's subject (`^#(\d+)\b`, never `#0`). Deliberately redundant — a detached worktree carries no upstream, so it falls through to the commit-subject rung; no single rung is load-bearing. **Never fetches** — `merge-base --is-ancestor` against `origin/<integration>` when the remote-tracking ref exists locally, else the local `<integration>` branch; a stale ref only makes `no-work` *under*-report, never over-report, the safe direction for something that removes files.

### Why background dispatch needs care

A non-allowlisted command must **auto-deny** (never prompt the human), or every stray command interrupts the operator. **A `PreToolUse` guard hook is what denies** — `${CLAUDE_PLUGIN_ROOT}/hooks/agent-guard.mjs`, registered on both `Bash` and the write tools (`Edit`/`Write`/`NotebookEdit`). It identifies a dispatched subagent from the hook payload (`agent_type`/`agent_id`, the transcript path, or a cwd under an `agent-<hash>` worktree — any one signal is sufficient; `/port:implement`'s own `impl-<n>` worktrees deliberately do not match, since that skill runs in an operator's session), and for a subagent call that misses the repository's allowlist (Bash) or targets a `sessionRequiredPaths` path (a write), it returns an explicit `permissionDecision: "deny"`. That decision is independent of the parent session's permission mode — no dialog can reach the operator regardless of whether the cockpit is running `default`, `acceptEdits`, `bypassPermissions`, or `auto`.

Stage agents still declare **`permissionMode: dontAsk`** in their frontmatter — that stays as declared intent and a second line of defence, but it has never been observed denying anything on its own; the guard hook is what actually does. **Run the cockpit session in `default` mode anyway** — not for the deny, but so *your own* edits are not auto-accepted and any residual dialog (a harness-level case the guard hook does not cover) is visible rather than silently approved. Because dispatched agents edit source, the allowlist must also grant **`Edit(**)` and `Write(**)`** so impl and revise can edit files the guard hook does not deny. It also grants **`Skill`**, bare, so `plan-agent` and `review-agent` — the two that name it in their own `tools:` — can actually invoke a passive-knowledge skill a declared plugin ships; the exposure stays bounded to plugins the repository itself declares in `enabledPlugins`. The model is **broad allow, authoritative deny**: allow whole dev-command categories, and use the `deny` list as the real safety surface for dangerous or interactive commands. Deny beats allow at every scope. A worktree is a checkout of `<integration>`, so it carries the *committed* settings — see "What a dispatched agent can see" for the full lag this creates, plugins included.

Agents also run with **`disallowedTools: Agent`** (no nested subagents), a **`maxTurns`** backstop, and the rule to **stop and emit `BLOCKED:`** rather than improvise when a command is denied. That instruction is reachable for the first time now: the guard hook's deny reason tells the agent to do exactly that, and the agent survives the denial to act on it, rather than stalling on an unanswered prompt.

**Cockpit rules.** The guard hook is not subagent-only: five rules apply to **any** caller — the cockpit's own session included. Four exempt an `/port:implement` operator worktree (`impl-<n>`, exempt because that skill's whole premise is running unguarded); the install rule and the claim rule's write-tool arm do not. Loop and gate exist because the cockpit itself violated the rail it was supposed to follow, under the same standing incentive to keep the pipeline moving; branch exists because a prose-only "hard refusal" was not one (#216); claim exists because a claimed gate needs the same kind of check a prose-only stand-down would not survive:

- **Loop rule** (#120) — a `gh`/`git` call wrapped in a shell `for`/`while`/`until` loop is denied. Purely syntactic: a `for`/`while`/`until` keyword and a `do` keyword, each at a shell command position, on the command with every quoted span blanked out first (so prose inside a `-b`/`-m`/`--jq` argument, e.g. `"a loop for each item to do"`, can never trip it). One dead turn inside such a loop left a split state machine across three issues for four days, because one iteration lands and the rest die with the turn.
- **Gate rule** (#138) — a `gh pr edit`/`gh issue edit` call removing `<labels.needsHuman>` is denied unless a recent operator message names that item (`#N`, or `N` standalone, in one of the last 5 user messages of the calling session's own transcript). The cockpit cleared its own `needs human` escalation thirteen minutes after `revise-agent` set it, unprompted and on a false justification (*"now that the conflict is resolved"* — nothing had moved), so the gate needed a check the same machine could not talk itself past. An unreadable or absent transcript is treated as **unverifiable, not unauthorised** — it still allows the call, but logs it as `gate-clear` rather than silently as an `allow`, so an unverified clear is auditable rather than invisible.
- **Claim rule** (#206) — see "External gate claim" below for the full contract. Two arms: a `gh pr edit`/`gh issue edit` adding or removing `<labels.planReview>`, `<labels.planApproved>`, or `<labels.planChangesRequested>` is denied while an external claim holds or cannot be read, exempt for a subagent and for `who.isOperatorWorktree` the same way the gate rule is; a `Write`/`Edit`/`NotebookEdit` targeting the claim file itself is denied for **every** caller, no exemption at all — a machine releasing its own constraint is the #138 failure again, and the cockpit's `allowed-tools` already grants it `Write`.
- **Install rule** (#144) — a `claude plugin install`/`uninstall`/`marketplace add`/`marketplace remove` call from a cwd anywhere under `.claude/worktrees/` is denied, for **any** caller, `impl-<n>` included. Every install scope resolves to the same `installPath` (see "Install identity" below), so an install performed from inside any managed worktree — a dispatched agent's, or an operator's own `/port:implement` worktree — silently repoints what **every** session on the machine loads, and keeps doing so after that worktree is gone. This is the one Bash-arm cockpit-class rule that does **not** exempt `who.isOperatorWorktree`: `/port:implement`'s premise is that the *worktree* is isolated, which an install specifically is not, since the blast radius reaches every other session regardless of who typed the command.
- **Branch rule** (#216) — a `git checkout`/`git switch` (bare, or via `git -C <path>`) is denied for any session that has ever invoked the cockpit skill. The startup preflight's own hard stop ("check one of those out and start me again") was escaped by a session that checked out the carrying branch itself and kept ticking; the tell is the harness's slash-command expansion wrapper anywhere in the transcript, never a bare `/port:pipeline` substring, which would also fire on any session that merely read `SKILL.md`. Coarse by design: a cockpit session's own `allowed-tools` grants it only read-only git commands in the first place, so a false deny costs nothing it is supposed to do. Like loop, gate, and claim, it checks `who.isOperatorWorktree` first and allows immediately when true — an `/port:implement` session's own branch switch is never in scope. The install rule checks `who.isManagedWorktree` instead — any `.claude/worktrees/` cwd, dispatched-agent or operator — and never exempts it.

**Install identity.** Install records carry a scope (`user`/`project`/`local`) and a commit (`gitCommitSha`), but every scope resolves to the same `installPath` on disk — a directory-sourced plugin is *copied* into the cache at install time, so the path cannot tell a stale copy from the working tree it came from, and an unbumped manifest `version` claims the same string regardless of which commit it holds. The only test that cannot be fooled is diffing the cache directory against the plugin source in the working tree; silence means the running plugin is the working tree. The cockpit's startup preflight resolves and prints the applicable record's commit and scope (see `skills/pipeline/SKILL.md` → "Running plugin identity") precisely so a session never has to fall back to that diff by hand.

### What a dispatched agent can see

Committed `.claude/settings.json` and `.claude/port.config.json` both lag by one merge: a worktree is cut from `<integration>`, so whatever is on disk on some other branch — including the main checkout's own branch — is invisible to it until that branch merges. The cockpit's startup preflight (`skills/pipeline/SKILL.md`) is what turns this from a silent trap into a reported one: it refuses to tick when the main checkout itself carries neither file, and warns when it is on a non-integration branch.

A **plugin** addition needs three things lined up, not just the merge:

- **Declared** — `enabledPlugins` merged to `<integration>`.
- **Cached** — the declared `version` present under `~/.claude/plugins/cache/`, a **machine-local** copy no git operation in the repository touches.
- **Loaded** — the cockpit session started after both of the above.

**Merging declares a plugin; it does not install one.** Whether a dispatched subagent re-resolves project settings from its worktree or inherits the parent session's plugin set does not change this sequence, because the **cached** condition is machine-level either way — verified empirically against a GitHub-sourced install, and the three gates are independent. The same three gates now bound a plugin's **skills**, once declared, cached, and loaded — they reach `plan-agent`/`review-agent` through the `Skill` grant above, no longer implicitly unreachable the way an auto-denied tool made them before it.

The ordering rule that follows: **a plugin addition is its own prerequisite ticket.** Land it, merge it, refresh the machine's plugin install so the declared version is actually cached, restart the cockpit — then dependent tickets, which declare the plugin ticket via `blockedBy` (the cockpit already warns about unmerged blockers at opt-in).

### The running plugin, and when it goes stale

The lag above is one merge, for a **dispatched agent's** worktree. This is the same lag one level up, for the **cockpit itself** — and here it compounds, because a self-hosting repository's cockpit shipping a fix is never the cockpit running it. A merge to `<integration>` is inert for the running session until the install is refreshed — the declared version pulled into the machine's plugin cache — and the session is restarted; until then the cockpit keeps following the rails it loaded at startup, whatever `<integration>` now says.

The startup preflight (`skills/pipeline/SKILL.md` → "Running plugin identity") resolves and prints the installed commit and scope so this is visible rather than silent, and computes **staleness relative to the remote** on top of that: how many commits the installed commit is behind the comparison target (a GitHub marketplace source's `ref`, or `<integration>` for the self-hosting case), recomputed on every tick because the count is usually `0` at startup and grows *during* the session as the target ref moves. A `0 → non-zero` crossing is announced once; every tick after that carries a one-clause staleness reminder on its closing line. Staleness is informational — nothing breaks while a session runs a stale copy, and the count is never computable without a resolvable comparison target, in which case the line says so rather than printing a wrong number.

**Denial visibility:** the guard hook logs every decision it makes — never an `allow` — to a gitignored `.agents/denials.log`. Each line is four tab-separated fields: `<iso8601>` `<decision>` `<who>` `<command-or-path>`, where `decision` is `deny`, `miss` (a non-subagent call that missed the allowlist — logged for visibility, never denied), `gate-clear` (an allowed, authorised removal of `<labels.needsHuman>` — **not a denial**, the audit record for a human gate being cleared), or `hook-error` (an internal failure, logged so a fail-open silently-broken hook is still visible); `who` is `port:<agent_type>` when the agent's type is known, else `subagent:<signal>`, else `session:<session_id>`; and `command-or-path` is whitespace-collapsed and truncated. A `deny` line can now carry a `session:` actor — the cockpit's own loop, gate, or branch rule firing against its own session, not a stage agent's allowlist miss, and worth reading differently: it means a rail held, not that a permission is missing. The cockpit reads it each tick and reports clusters of `deny` lines, breaking out any `session:`-actor line separately. A denied command now returns with the guard hook's reason rather than just erroring.

**Known gap — a native `permissions.deny` match is not logged.** The guard hook only ever sees `PreToolUse`, and only ever writes a line when *its own* classifier reaches `deny` or `miss` for one of its two cases (allowlist-missing Bash, a write to a `sessionRequiredPaths` path). A command that instead matches an explicit entry in `.claude/settings.json`'s native `permissions.deny` list — independent of the guard hook's own logic — is still denied (deny beats allow at every scope, per "The model is broad allow, authoritative deny" above), but nothing writes to `.agents/denials.log` for it: the hook that used to log that event (`PermissionDenied`) was removed with this change, and nothing replaces it. That class of denial is real but currently invisible to the cockpit's cluster reporting.

### File-based GitHub I/O

Agents never pass large markdown (plans, reviews, comments) as an inline `--body "..."` argument — shell quoting of backticks and code fences fails cross-platform. They write the payload to `.temp/` (gitignored) and use `gh ... --body-file`. The same applies to the cockpit's escalation comments.

### Operating rules (all stage agents)

Canonical rules every stage agent follows. A Bash command matches the allowlist only if it **starts with an allowlisted binary AND parses cleanly**; otherwise it falls through to a prompt that a background agent auto-denies.

- **Check the repository's `.claude/settings.json` for what is actually allowed** rather than guessing from memory. The base allowlist grants `gh`, `git`, the repository's package manager, a set of read-only inspection commands, and `Edit(**)`/`Write(**)`; `extraAllow` adds anything else the repository needs.

<!-- shell-discipline:begin -->
**Shell discipline — every Bash call.** The allowlist matches the **whole command string from its first token**, so a command that chains or pipes into anything else fails the match no matter what its parts do.

- **One command per call.** No `;`, `&&`, `||`, `for`/`while`, `if`/`[`, subshells, multi-line scripts, or a pipe into a non-allowlisted binary. Never `sh -c '…'` or `bash -c '…'`.
- **Start with an allowlisted binary, bare.** No `cd …` prefix and no `ENV=val` prefix — `GIT_EDITOR=true git …` misses `Bash(git *)`; use `git -c core.editor=true …`.
- **Never allowlisted, in any repository** — `echo`, `cat`, `head`, `tail`, `cut`, `diff`, `which`, `tee`, `xargs`, `base64`, `jq`, `sed`, `awk`, `python3`, `node -e`, `perl`. A denial there means *use a tool*, not retry with different flags. Probing the host or the Claude install is never part of a stage's job; if you genuinely need an unlisted binary that is a `BLOCKED:`, not something to route around.
- **Read, search, and list with Read, Grep, and Glob.** `grep`, `find`, `ls`, and `wc` *are* in the base allowlist, but the tools are cheaper and gitignore-aware. List a directory → **Glob**, scoped to source directories, never a root-level `**/*`; read or count a file → **Read**; search or test for text → **Grep**.
- **Quote every path argument**, cwd-relative with forward slashes. **Write files with Write and Edit** — never a redirect or heredoc; delete tracked files with `git rm "<path>"`.
- **Sanctioned recipes** for what the tools cannot reach:
  - filter JSON → `gh … --json … --jq '…'`, never `| jq` or a piped interpreter.
  - a file at a ref that is not checked out → `gh api "repos/<repo>/contents/<path>?ref=<sha>" -H "Accept: application/vnd.github.raw"` — one command, no pipe, no `base64 -d`.
  - large markdown to GitHub → Write it under `.temp/`, then `--body-file` / `--input`.
<!-- shell-discipline:end -->

- **When denied, stop — do not improvise.** A denied command returns a hook denial with a reason, not a prompt — the guard hook decided, not you. Do not retry or route around it: **emit `BLOCKED: <exact denied command + what you needed>`** so the cockpit surfaces it. Never spawn subagents.

## Label lifecycle

Rule: **every stage agent's first action is swapping its trigger label for its in-flight label.** Absence of a trigger label means the cockpit skips the item, so a tick can never double-dispatch. **An in-flight label means a stage *claimed* the item, never that an agent is still alive** — a crashed or killed agent leaves the label in place with nothing running. Liveness is a separate question, answered by `TaskList`, not by the label; see "Liveness" under Escalation. Recovery either way is re-applying the trigger label (`retry #N`) — for `impl-agent` specifically, that re-dispatch resumes from the branch the prior attempt pushed rather than re-implementing it, per `RECOVERY.md` → "Resume protocol".

**The `<labels.X>` placeholder is a config lookup, never a label name.** `X` is a `.claude/port.config.json` `labels` key from the `Config key` column below; the resolved name a `gh` call actually uses is `labels[key] ?? default` — the repository's override when `labels` sets one, otherwise the `Label` column's default. So `<labels.planApproved>` resolves to `plan approved` in a repository with no override, never to the literal string `planApproved`. Because `gh issue list --label <unknown>` returns `[]` with exit code 0, a component that types the key instead of the resolved name gets a silently empty result, never an error — resolve every name from this table (or the live config) before issuing a `--label` argument.

### Issue labels

| Config key | Label | Set by | Type | Meaning |
| --- | --- | --- | --- | --- |
| `marker` | `claude` | Cockpit (at opt-in) | marker | The pipeline is handling this ticket |
| `ready` | `ready` | Cockpit (at opt-in) | trigger | Dispatch `plan-agent` |
| `planning` | `planning` | `plan-agent` | in-flight | Plan being researched and written |
| `planReview` | `plan review` | `plan-agent` | gate | Plan written — awaiting human approval in the cockpit |
| `planChangesRequested` | `plan changes requested` | Cockpit (human feedback) | trigger | Dispatch `plan-agent` in revision mode |
| `planApproved` | `plan approved` | Cockpit (human approval, or `auto plan`) | trigger | Dispatch `impl-agent` |
| `autoPlan` | `auto plan` | Cockpit (at opt-in) | marker | Plan gate skipped: `plan review` auto-approved |
| `inProgress` | `in progress` | `impl-agent` | in-flight | Implementation underway |
| `prOpened` | `pr opened` | `impl-agent` | terminal | Pull request open; remaining state tracked there |
| `blocked` | `blocked` | `impl-agent` | gate | Needs a human decision; details in an issue comment |

### Pull request labels

| Config key | Label | Set by | Type | Meaning |
| --- | --- | --- | --- | --- |
| `marker` | `claude` | `impl-agent` (at `gh pr create`) | marker | The pipeline owns this pull request |
| `readyForReview` | `ready for review` | `impl-agent` / `revise-agent` | trigger | Dispatch `review-agent` |
| `reviewing` | `reviewing` | `review-agent` | in-flight | Review underway |
| `needsRevision` | `needs revision` | `review-agent` | trigger | Dispatch `revise-agent` (subject to the cycle cap) |
| `revising` | `revising` | `revise-agent` | in-flight | Fixes underway |
| `approved` | `approved` | `review-agent` | terminal | Findings are at or under the current cycle's bar; a human merges. Removed only under the `## Check evidence` carve-out — a check on it has gone red since approval, or a same-SHA refresh loop is stuck |
| `needsHuman` | `needs human` | Cockpit / `revise-agent` | gate | Cycle cap reached (unconditional — whatever the latest verdict said), an ambiguous rebase conflict, or a zero-diff review bounce (the newest review already covers the current head); the pipeline stops. Clears only via `unblock #N` — the guard hook denies any other removal, cockpit included |
| `refreshBranch` | `refresh branch` | Cockpit / human | trigger | Dispatch `revise-agent` in refresh mode |
| `refreshing` | `refreshing` | `revise-agent` | in-flight | Branch refresh underway; other labels are left in place |

## Stages and models

| Stage | Definition | Model | Why |
| --- | --- | --- | --- |
| Cockpit | `skills/pipeline/` | haiku recommended (session) | Mechanical: one query, label swaps, dispatch, relaying — a skill cannot set the session model, so this is a recommendation the operator's own choice can override |
| 0. Scope | `skills/scope/` | inherits session | Highest-leverage thinking; the human is in the conversation |
| 1. Plan | `agents/plan-agent.md` | `models.plan` | Design-rich planning; quality amplifies downstream |
| 2. Implement | `agents/impl-agent.md` | `models.impl` | Bulk of the code volume |
| 3. Review | `agents/review-agent.md` | `models.review` | Must catch real problems reliably |
| 4. Revise | `agents/revise-agent.md` | `models.revise` | Targeted fixes from a structured list |

When `docs.engineering` is set, all four workers read it before working, and `review-agent` treats it as a review dimension; when `docs.design` is set, the same four read it for interface work and `review-agent` treats it as a review dimension too, with `docs.engineering` winning any genuine overlap (accessibility lives there). When either is null they work from the plan, the ticket, and the surrounding code.

**Stages 2 and 4 have an operator variant.** Some tickets cannot be implemented by a dispatched agent at all, because the harness denies its edits under `sessionRequiredPaths`. Those two stages then run in the operator's own session via `/port:implement` — see "Session-required tickets".

## Permission model

Stage agents do real work — install packages, read CI logs, manage git in their worktree — so the allowlist grants broad categories and the deny list draws the safety line.

The installer (`/port:init`) writes both lists into the repository's `.claude/settings.json`, because **a plugin cannot ship permission rules**; they exist only in user or project settings. Templates live in the plugin's `templates/permissions.base.json`, with `<integration>` and `<production>` substituted into the push-deny rules — `<production>` null drops its three deny entries entirely, the same as `{{packageManager}}` with no package manager. Every entry generated for a `commands.*` command — the installer's own, and any appended to `extraAllow` — carries a trailing ` *` (#205): the matcher treats anything else as whole-command-exact, so a bare `Bash(<command>)` denies every invocation an agent appends `2>&1 | tail -N` to. Independently, the guard hook resolves an in-repo absolute invocation to its repo-relative form before calling an allowlist miss, so a `commands.*` command spelled with the harness's requested absolute path is the same decision as the relative form the wildcard already covers — a path outside the configured root is left unresolved and still misses. The trailing wildcard **fails toward availability**, deliberately: it also matches `<command>; <anything>`, which the bare form did not. That is the right trade because the alternative failed closed on every dispatched agent at once — an unreachable green check, so no push and a stalled item — while the widening is bounded to a command the repository already configured and runs on every cycle. What the widening actually grants is narrower than it looks, and **it is not the deny list that bounds it** (#212): **the guard hook is deny-only — it emits `permissionDecision: "deny"` and never `"allow"`** — so a wildcard entry only widens what the *hook* declines to object to, and the harness's own allow matching still runs independently afterward. Per "A hook records a harness decision; it never re-derives one", whatever the harness does with the chained form is the harness's call, not something this repository restates. **The residual gap, stated plainly:** nothing here adjudicates what is chained *after* a matched prefix — allow and deny matching both key off a command's leading tokens, so a deny pattern cannot fire on a command that merely contains a dangerous call further along the line. That is the same unpatternable shell composition "Known gap — shell redirection cannot be denied by pattern" records below, and what carries the weight instead is the shell-discipline block's **one command per call** convention, which every stage prompt states and `shell-discipline.mjs` pins byte-identically. **Any permission change must be reflected there and here.**

Deny rules cover, at minimum: merging a pull request (the human merge gate is absolute), deleting issues or repositories, authentication commands, direct pushes to `<integration>` and `<production>`, package publication and login, and `find`'s command-executing and deleting flags. Push-deny needs **both** the bare-branch form (`git push * <branch>`, which also catches `--force` and `--delete`) **and** the refspec form (`git push *:<branch>`, which catches `HEAD:<branch>`, `<sha>:<branch>`, force-push, and delete). `find` needs both its leading-path and no-leading-path forms, because it defaults to searching `.` when given no path, so a bare invocation has no token for a leading-argument pattern to match.

Branch protection on `<integration>` (and `<production>`, when the repository has one) is the authoritative backstop; the deny list is defence in depth.

### Known gap — shell redirection cannot be denied by pattern

A `permissions.deny` pattern cannot stop an allowlisted read-only command from writing files via `>`, `>>`, or `| tee`. Allow and deny matching operates on parsed command tokens — which is why an argument-based pattern like `find * -exec *` works — while shell redirection operators are consumed by the shell layer and never reach the string being compared. This was tested directly: a pattern anchored on the command name still let `echo hi > file` through.

**The mitigation is the allowlist itself**, which is why content emitters are excluded. The commands that remain emit search results, paths, or metadata rather than arbitrary content. **This narrows the bypass; it does not close it** — `grep -v x f > f` still strips lines, any allowed command can truncate a redirect target, and a broad `git` allow has always offered write primitives through `git apply` and `git checkout --`.

So "write files with the Write and Edit tools" is a **convention agents are expected to follow, not a technical guarantee** — and `plan-agent`'s and `review-agent`'s read-only status rests on them following it. **The guard hook described above is the `PreToolUse` deny this section used to ask for** — it inspects the raw Bash command string and returns a deny decision for a dispatched subagent's allowlist miss. What it does not close: shell redirection through an *allowed* command remains ungated, since the hook (like the harness's own matching) operates on parsed command tokens, and the redirection operators are consumed by the shell layer before either ever sees them.

### External gate claim

A second surface can look at the same repository — a desktop application — and the plan-review gate is the one decision the cockpit must not race it on. **The claim file**, `<base repository root>/.agents/gate-claim.json`, resolved through `git rev-parse --git-common-dir` so every worktree of a checkout sees the one claim rather than a per-worktree copy — the same resolution `.agents/denials.log` already uses:

```json
{
  "repo": "b-at-neu/port",
  "owner": "port-desktop",
  "scopes": ["plan-gate"],
  "claimedAt": "2026-09-05T14:02:11Z"
}
```

**Three read verdicts**, mirroring the desktop app's own claim reader exactly, since both sides of the gate must agree on what the same bytes mean:

| Verdict | Condition | Effect |
| --- | --- | --- |
| `absent` | file not found, or `repo` names a different repository | the cockpit answers the gate as always; the hook denies nothing |
| `held` | parses, `repo` matches, `owner` and `claimedAt` are strings | `scopes` includes `plan-gate` → the cockpit stands down and the hook denies; any other scope entry is reported, never silently dropped, and never itself denied on |
| `unreadable` | exists but unparseable, not an object, or missing `owner`/`claimedAt` | stand down and deny, exactly as `held` — a malformed claim's only ambiguity is which writer owns the gate, and standing both down is the one reading that cannot produce an unintended decision |

A claim never expires — no `claimedAt` age is ever compared against a clock — because an expiry would produce a silent ownership transfer back to the cockpit, which is a wrong decision dressed as a timeout. `owner` is free text for the report only, never liveness: nothing in this file may stand in for a heartbeat.

**The label set this covers**: `<labels.planReview>`, `<labels.planApproved>`, `<labels.planChangesRequested>` — every write the plan-review gate makes, both directions. `<labels.autoPlan>` is deliberately **outside** the set: the cockpit's opt-in path still sets it, and the auto-plan *swap* it triggers is already covered by `<labels.planApproved>` being in the set, so denying `autoPlan` itself would add nothing.

**The cockpit's own rule**: read the claim at startup and again every tick (`skills/pipeline/PREFLIGHT.md` → the gate-claim step, `skills/pipeline/SKILL.md` → the per-tick re-read). A `held` verdict naming `plan-gate`, or an `unreadable` one, means the plan-review gate is never answered this session — no `AskUserQuestion`, no label swap — only reported, once per tick while it holds, never a silent omission. `absent` answers the gate exactly as before this ticket existed.

**The hook's own enforcement** is the load-bearing half — see "Cockpit rules" → "Claim rule" above for both arms. The cockpit's own stand-down is enforced twice for the same reason every other cockpit-class rule is: a prose rail is not enough on its own, and the hook is what actually denies when the model does not.

### CI merge gate

> **Module: `approvalGate`.** Skip this section when the flag is false. Nothing else changes: `review-agent` still applies `approved` and the cockpit still announces it, but the merge gate is conversational rather than enforced.

A workflow gates pull requests into `<integration>` on the `approved` label, **but only when the pull request carries `claude`** (a job-level condition). Every other pull request — human, dependency bot — gets a skipped check run, which GitHub counts as satisfied, so it merges on its own merits.

This is deliberately **fail-open**: an unlabelled pipeline pull request is indistinguishable in CI from a human one and simply loses its gate. Nothing in the workflow can close that, so the mitigations live upstream — `impl-agent` passes `--label "claude"` at creation time so the gate is live on the first event, and the cockpit's **ungated sweep** reports any tracked pull request missing it.

**Never narrow the workflow's trigger to exclude a pull request.** A workflow that never runs creates no check run, leaving a required check pending forever. For the same reason, the workflow is scoped to `<integration>` only — release pull requests into `<production>` carry no pipeline labels and must not be gated. In single-branch mode that carve-out is vacuous: every pull request targets `<integration>`, so every pipeline pull request is gated.

The gate is only *enforced* if the check is registered as required in a branch ruleset. Creating that ruleset is an administrative action the installer deliberately does not take; until it exists the gate is advisory.

### Branch refresh

Refresh is the one route for a stale branch: rebase it onto its base and force-push, with **no review reading, no bootstrap, no code edits, no new commits**. Reachable two ways:

- **Automatic** — the cockpit's dispatch gate, its approved re-verify, and `review-agent`'s own mergeability exit all read `mergeable: CONFLICTING` and route the pull request to `<labels.refreshBranch>` instead of `<labels.needsRevision>`, leaving its stage label — and `<labels.approved>`, if present — in place. See "The `<labels.approved>` carve-out" under "Check evidence".
- **Manual** — `refresh #N`, for any other reason a human wants a fresh push. Freeing a preview-deployment slot for a redeploy is one such reason, not the definition.

Both routes dispatch `revise-agent` in refresh mode (`revise-agent.md` → "Refresh mode"): fetch, rebase onto the base branch — resolving conflicts through the same **Rebase conflict protocol** (`RECOVERY.md`) as any other rebase — then force-push, skipping the push on a no-op rebase. Note that a refresh consumes no review cycle, since no review runs and nothing is counted.

Two further bounds, enforced by the cockpit — the exact constants live in `pipeline/SKILL.md`, not here: never refresh a head SHA this session already refreshed (escalate to `<labels.needsHuman>` instead), and a capped number of refreshes per tick and consecutive refreshes per pull request, past which a non-converging branch also escalates.

## Session-required tickets

**Some tickets cannot be handed to a dispatched agent at all, so stages 2 and 4 run in the operator's own session.** The mechanism is built around the *routing*, not the cause, so a new category reuses it by supplying a different reason.

**The harness denies a subagent's edits under `.claude/`, and settings cannot grant it back** — that restriction sits above project configuration, so there is nothing to fix in the permission model. An operator's **main session** is unaffected: reading an agent definition and acting on it spawns no subagent, so no subagent restriction applies. That asymmetry is the whole basis of this route.

The paths that trigger it come from `sessionRequiredPaths`, which defaults to `CLAUDE.md`, `.claude/**`, and `.claude/port.config.json`.

### What the determination covers

`plan-agent` scans the **whole plan** — `## Changes`, `## Implementation`, and `## Testing` — not just the changed-file list, because a write under `sessionRequiredPaths` is unreachable for a dispatched subagent by any route, even a transient one that gets reverted before the plan finishes. Two outcomes:

- **A deliverable touch** (`## Changes` / `## Implementation`) forces the whole-plan `SESSION REQUIRED` marker.
- **A verification-only touch** (the write appears only in `## Testing`) leaves the ticket dispatchable, and that one step is marked **operator-only** instead — `impl-agent` skips it, and it carries into the pull request's testing plan verbatim for the operator to run before merge.

This closes #55: a plan whose deliverables never touched `.claude/**` but whose testing steps did was classified plainly dispatchable, and the dispatched agent died on the permission prompt the first outcome above now prevents.

### The marker

One string, one rendering, both surfaces — **`SESSION REQUIRED`**, with the reason after the colon:

```
> **SESSION REQUIRED:** touches `.claude/**` — a dispatched agent can't edit those
```

| Surface | Written by | Where |
| --- | --- | --- |
| **Issue** | `plan-agent` | The plan block's slot (see **Detection**) — first non-empty line under `## Implementation Plan`, before `## Overview` |
| **Pull request** | `/port:implement` | The slot directly under `Closes #N` (see **Detection**) |

The literal string `SESSION REQUIRED` is the contract — **never reword it**; the reason after the colon is free text and is the part that generalizes. **There is deliberately no label.** The marker lives in the body on both surfaces, and the cockpit reads it from the `body` field of the trigger query it already runs, so the check costs no extra call and there is nothing to keep in sync.

### Detection

**Slot plus form, never a body-wide substring search.** An item is session-required only when its **marker slot** holds, as its first non-empty line, the canonical rendering `> **SESSION REQUIRED:** <reason>` at the start of the line, with a non-empty reason:

- **Issue slot** — the first non-empty line of the plan block, directly under the `## Implementation Plan` heading. (The plan is *appended* below the human-authored ticket, so the body's own first line is never the plan's — "first line of the body" is the wrong test.)
- **Pull request slot** — the first non-empty line after `Closes #N`.

**Both, or neither.** The words `SESSION REQUIRED` appearing anywhere else — prose explaining the mechanism, inline code, a fenced block, or the canonical rendering repeated further down — are not a marker. A ticket that *discusses* the marker (this one does) carries none at its slot and is not session-required.

**Fail open.** Slot absent, empty, or holding anything other than the canonical rendering → not session-required → dispatch normally. The two failure directions are not symmetric: a false positive stalls an item forever, silently — a trigger label at rest already looks exactly like normal in-flight work — while a false negative ends in one denied edit, a `BLOCKED:` relay, and one retry. When the slot is ambiguous, resolve toward the recoverable failure.

### The route

1. **Declare.** `plan-agent` emits the marker when the plan touches a matching path.
2. **Skip dispatch.** The cockpit finds it in the trigger query's `body` and **announces the command instead of dispatching**. The item keeps its trigger label.
3. **Run.** The operator opens a **named session** and runs `/port:implement <issue-or-pr-number>`. That skill resolves the stage from the item's labels, creates a dedicated worktree, follows the **unmodified** agent definitions plus a short list of subagent-only overrides, and repeats the marker in the pull request description. The override list lives in the skill and nowhere else — one place to drift, one place to check.

**What moves and what does not.** Only stages **2** and **4**. `plan-agent` and `review-agent` are read-only and work through `gh`, so stages 1 and 3 run unchanged — a session-required ticket is **not** out of the pipeline. A refresh is still dispatched too: a rebase and force-push edit no files, and a conflict inside a protected path is already on the never-touch list and escalates.

**The invariant this deviates from.** Everywhere else a trigger label means something is dispatching. A session-required item **keeps** its trigger label and is **never** dispatched. Recovery is unchanged, but the label alone no longer implies motion — which is why `status` has to call these out explicitly. Nothing else distinguishes one from an item that is genuinely mid-flight.

**Session naming.** These sessions are long-lived and several run at once, so launch each with the issue number in its display name:

```bash
claude -n "#503: operator config route"   # then, in that session: /port:implement 503
```

A running session **can** be renamed: `/rename <name>` works, and where a session-title tool is in scope a skill can set the title itself. So the cockpit hands over the launch command with the name pre-filled as a convenience, not a necessity — an operator who already has a session open renames it rather than starting a new one. The name always carries the **issue** number, even when the command takes a pull request number.

Note the asymmetry when implementing this: a session-title **tool** can be called by a skill, while `/rename` is typed by the operator. A skill can never issue the slash command itself.

**Always in a worktree.** `/port:implement` never works in the main checkout, for two reasons: editing `.claude/` from the session that is *using* it mutates live configuration mid-task, and the ticket may be editing the very agent file the session is following. In a worktree the session reads its instructions from the installed plugin while every edit lands on the worktree copy, so the committed behaviour holds for the whole run.

## Check evidence

One shared contract, read by `review-agent` before it forms a verdict and by the cockpit before it calls a pull request merge-ready. Neither ever reads `gh pr checks`' exit code as the answer: `8` means pending, and `1` covers both "a check failed" and "no checks reported" — always re-read the rollup itself.

**Read and reduce.** `gh pr view <n> --repo <repo> --json headRefOid,statusCheckRollup`. The rollup carries one entry per **event**, not per check — the approval gate alone re-runs on every `labeled`/`unlabeled` event, so a pull request that has been through a few label changes can carry five or more entries for the same check name, and reading any but the newest is reading a stale answer. **Reduce to the latest entry per check name** (`.name` for a CheckRun, `.context` for a StatusContext — read as `(.name // .context)`) by `startedAt`, falling back to `completedAt` when `startedAt` is absent. Then read `(.status, .conclusion)` for a CheckRun or `.state` for a StatusContext, via the existing `(.conclusion // .state)` fallback.

**Concluded, green, and empty.** **Concluded** is `status == "COMPLETED"` (CheckRun) or `state != "PENDING"` (StatusContext). **Green** is `SUCCESS`, `NEUTRAL`, or `SKIPPED`; every other conclusion — `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `ERROR`, `CANCELLED` — is **not evidence of passing** and blocks. **An empty rollup is pending, never green** — no checks reported is the absence of evidence, not its presence. A repository with no CI at all will therefore park every pull request here; that is a known, deliberately conservative limitation, not a bug to route around.

**The one carve-out.** Only when `modules.approvalGate` is true: read `.github/workflows/approval-check.yml` (the path `/port:init` installs the module's workflow at) and take the single key under `jobs:` as the check-run name to excuse — derived from the file, never typed as a literal, so a repository that renamed the job is still correct. File absent, or the module false → **no carve-out at all, and every red check blocks.** The excused check is excluded from **verdicts and routing only** — it is always listed with its real conclusion wherever conclusions are reported. This list has **exactly one entry**; widening it is the failure this section exists to prevent.

**The head must not move.** Record `headRefOid` before any wait and re-read it after. A different SHA means the evidence belongs to a different diff, and no verdict formed against the old one is valid — the caller re-reads or bails out; see `review-agent.md` step 4 for the exact exit.

**Mergeability precondition, ahead of the wait.** Read `mergeable` in the same `gh pr view` call (`headRefOid,statusCheckRollup,mergeable`). `CONFLICTING` means GitHub cannot build a merge ref for this pull request, so its check rollup **never concludes** — not slowly, not eventually, never — because the workflows that would populate it never run against a diff GitHub cannot construct. Without this precondition, the empty-rollup-is-pending rule above would park a conflicting pull request through the full bounded wait and then hand it to `<labels.needsHuman>` after roughly 30 minutes, misreporting a mechanical fact (the branches diverged) as an unexplained check timeout. So `CONFLICTING` is read **before** the bounded wait and short-circuits it: no verdict is formed, no check is waited on, and the pull request is labelled `<labels.refreshBranch>` — in addition to its current stage label, never in place of it — with a `## Rebase required` comment explaining why (see `FORMATS.md` → "Rebase required" and "Branch refresh") — `review-agent` at its own exit, the cockpit at the dispatch gate and the approved re-verify. `UNKNOWN` never blocks this precondition: GitHub has not computed mergeability yet, which is normal on a freshly opened or freshly pushed pull request, and the caller proceeds as if `MERGEABLE` — the read itself is what triggers GitHub to compute it.

**Bounded wait.** `gh pr checks <n> --repo <repo> --watch --interval 30` under a Bash timeout of `600000` ms, at most **3** times (~30 minutes total). `--watch`'s own output shape is not part of the contract — never parse it; after each wait, re-read `statusCheckRollup` directly. A timeout is a `BLOCKED:`, never a pass: a repository with genuinely slow checks parks here rather than getting a wrong answer.

**The `<labels.approved>` carve-out to the never-touch rail — exactly three authorising facts, two that remove it and one that does not.** The cockpit may touch `<labels.approved>` on a pull request **only** when it has just read, on that pull request's **current** head: a red conclusion — other than the excused check above — for a named check, `mergeable: CONFLICTING`, **or** a stuck same-SHA refresh loop (see `SKILL.md` → "Refresh sweep" step 1, "Same-SHA guard"). **The red-check fact and the stuck-refresh-loop fact both remove it.** The red-check fact routes to `<labels.needsRevision>` with `## Approval withdrawn` naming the check. The stuck-refresh-loop fact routes straight to `<labels.needsHuman>` — the cockpit drops the label itself rather than dispatching `revise-agent`, since the whole point of the guard is that a refresh here is already known to change nothing; dispatching only to have `revise-agent` rediscover that and strip the label from inside a run that accomplishes nothing else would cost a full agent turn to reach the same outcome the cockpit can already see. **The conflicting fact never removes it** — it authorises *adding* `<labels.refreshBranch>` alongside the existing `<labels.approved>`, with a `## Rebase required` comment, since a clean rebase does not change the diff that was approved; only if `revise-agent`'s refresh mode has to actually resolve a conflict — the diff is no longer the one that was approved — does it withdraw the approval itself (see `revise-agent.md` → "Refresh mode"). These are the **sole** authorising facts for touching the label at all; none is a general licence to revisit terminal states, and none is a guard-hook rule — the hook cannot observe "a check went red," "GitHub reports a conflict," or "this SHA was already refreshed this session," so the mechanical guard here is the layer-1 prose check plus the eval cases regression-testing each, not `agent-guard.mjs`.

**No scheduled rebase — on demand, from `mergeable`, only.** A rebase force-pushes and re-runs every check on a pull request, so refreshing every open one whenever `<integration>` moves would multiply CI churn to prevent a condition `mergeable` already reports exactly and for free. Pull requests are therefore rebased **only** when GitHub itself reports `CONFLICTING` — at the review dispatch gate, at the approved re-verify, or inside `revise-agent`'s own rebase step — never on a schedule and never because the base "might have moved." This is a decision, not an omission: it was considered and rejected for the CI-churn cost above, and is recorded here so it is not re-litigated.

**Zero-diff review.** A head SHA a `## Code Review` has already been submitted against gets no second cycle: before every `<labels.readyForReview>` dispatch the cockpit compares the newest review's `commit.oid` against the pull request's current `headRefOid` (see `SKILL.md` → "Zero-diff review gate"). Equal, with no `## Gate cleared` comment newer than that review's `submittedAt` → escalate to `<labels.needsHuman>` instead of dispatching a review that would grade a diff it already graded. A `## Gate cleared` comment newer than the review authorizes exactly one more review against the same head — the next review resets the comparison by construction. This is a head-SHA rule in the same family as "The head must not move" above, checking the other side of the same fact: that rule protects one review's evidence from going stale mid-wait; this one stops a *second* review from ever being dispatched against a diff already graded.

