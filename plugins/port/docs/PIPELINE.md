# Agent Pipeline

This plugin takes GitHub issues from idea to merge-ready pull request with minimal human intervention. A `/port:pipeline` session is the human's cockpit: it polls GitHub, dispatches background stage subagents, relays their questions, and applies every label. Humans converse; they never run `gh` commands. Each operator runs their own cockpit, and every query is scoped to that operator's assigned items (see "Multi-operator partitioning"). GitHub labels remain the durable state machine, so progress is always visible on GitHub and manual intervention always works.

**This document is the single source of truth for the operating rules, label lifecycle, permission model, and output formats.** Every stage agent reads it before working and restates only the rules unique to itself.

Agents and skills reference it as `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md`, which resolves to the plugin's installed location. Other plugin paths below (`agents/`, `skills/`, `templates/`) are relative to that same root.

## Configuration

Everything repository-specific lives in `.claude/port.config.json`, committed alongside the repository’s Claude settings, so it is reviewable in pull requests. Field reference: `schema/port.config.schema.json`.

**How each agent reads it depends on its worktree.** `plan-agent` and `review-agent` run without `isolation: worktree`, so `.claude/port.config.json` is on disk and they read it with the Read tool. `impl-agent` and `revise-agent` run under `isolation: worktree`, whose initial checkout is **not trustworthy** — confirmed by direct inspection, it can land on an unrelated, stale ref (`origin/main`, pinned to a commit predating this repository's `.claude/` directory) rather than the repository's actual default branch, regardless of what `branches.integration` says. Reading local `HEAD` there fails exactly like a missing file. Both agents instead resolve the remote's real default branch live (`git remote set-head origin --auto`), fetch it, and read `git show origin/HEAD:.claude/port.config.json` — the committed blob out of the object store, independent of whatever the worktree happened to check out. `/port:implement`'s own worktrees are a full `git worktree add … origin/<integration>` and do carry `.claude/` on disk, so that skill's session reads it with the Read tool as usual.

Throughout this document:

| Placeholder | Means |
| --- | --- |
| `<repo>` | `repo` — the `owner/name` every `gh` call is scoped to |
| `<integration>` | `branches.integration` — what feature pull requests target |
| `<production>` | `branches.production` — what releases promote to |

Label names are written as their defaults (`ready`, `plan review`, …). A repository may rename any of them through `labels`, in which case the renamed string is what agents read and write.

**Two sections are optional subsystems**, marked at their heading and inert when their flag is false: "Preview-database concurrency" (`modules.previewDatabase`) and "CI merge gate" (`modules.approvalGate`). When a module is off, its labels are never created, its queries never run, and the agents carry no instructions about it.

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
- **`impl-agent` and `revise-agent` get their own isolated git worktree** — a fresh checkout where they run `commands.bootstrap`, do the work, and push a feature branch. impl rebases onto `<integration>` and opens its pull request with `--base <integration>`; **revise rebases onto the pull request's own base branch** (`baseRefName`, never an assumed branch), autonomously resolving structurally unambiguous conflicts and escalating only ambiguous ones (see "Rebase conflict protocol"). No manual `git worktree`, symlinks, or environment files are involved.
- **`plan-agent` and `review-agent` are read-only on source** (`disallowedTools: Edit`); they only read code and write to GitHub via `gh`.

### Multi-operator partitioning

Ownership is the second dimension of pipeline state: **labels say what stage an item is in, the GitHub assignee says whose cockpit owns it.** Every cockpit tick query is filtered to `--assignee "@me"` (issues and pull requests alike), and `impl-agent` copies the issue's assignee onto the pull request it opens, so an item stays inside one operator's view for its whole life. The invariant:

- **One cockpit per person, disjoint assignee sets.** Without the filter, every cockpit sees every item — operator B's terminal pops the plan gate for operator A's ticket, and B's approval is authoritative.
- **Exactly one assignee per in-flight pipeline item.** Two assignees means two cockpits both dispatch for it. Nothing enforces this; the cockpit's take-over flow (`work on #N` on someone else's ticket asks Take over / Cancel) is the whole mitigation.
- `@me` resolves to that session's `gh auth` account, so **two operators sharing a machine account silently restores the unpartitioned behaviour.**
- **An unassigned pipeline item is invisible to every cockpit.** The failure mode shifts rather than vanishing — pre-filter a ticket was seen by too many cockpits, post-filter an unowned one is seen by none. Each tick therefore runs an **unowned sweep** (one issue query, one pull request query, `no:assignee` narrowed by `--jq` to trigger and gate labels) and reports the set when it changes, without ever acting on it. `/port:scope` leaves backlog tickets unassigned by design — opt-in (`work on #N`) is what claims them, and it assigns as well as labels.

The **double-dispatch race is known and unfixed**: the trigger-to-in-flight label swap happens inside the agent after spawn, so a check-then-act window of tens of seconds remains. Disjoint assignee sets avoid it in practice; closing it properly means moving the swap into the cockpit, before the `Agent()` call.

### Why background dispatch needs care

A non-allowlisted command must **auto-deny** (never prompt the human), or every stray command interrupts the operator. **A `PreToolUse` guard hook is what denies** — `${CLAUDE_PLUGIN_ROOT}/hooks/agent-guard.mjs`, registered on both `Bash` and the write tools (`Edit`/`Write`/`NotebookEdit`). It identifies a dispatched subagent from the hook payload (`agent_type`/`agent_id`, the transcript path, or a cwd under an `agent-<hash>` worktree — any one signal is sufficient; `/port:implement`'s own `impl-<n>` worktrees deliberately do not match, since that skill runs in an operator's session), and for a subagent call that misses the repository's allowlist (Bash) or targets a `sessionRequiredPaths` path (a write), it returns an explicit `permissionDecision: "deny"`. That decision is independent of the parent session's permission mode — no dialog can reach the operator regardless of whether the cockpit is running `default`, `acceptEdits`, `bypassPermissions`, or `auto`.

Stage agents still declare **`permissionMode: dontAsk`** in their frontmatter — that stays as declared intent and a second line of defence, but it has never been observed denying anything on its own; the guard hook is what actually does. **Run the cockpit session in `default` mode anyway** — not for the deny, but so *your own* edits are not auto-accepted and any residual dialog (a harness-level case the guard hook does not cover) is visible rather than silently approved. Because dispatched agents edit source, the allowlist must also grant **`Edit(**)` and `Write(**)`** so impl and revise can edit files the guard hook does not deny.

The model is **broad allow, authoritative deny**: allow whole dev-command categories, and use the `deny` list as the real safety surface for dangerous or interactive commands. Deny beats allow at every scope. A worktree is a checkout of `<integration>`, so it carries the *committed* settings — see "What a dispatched agent can see" for the full lag this creates, plugins included.

Agents also run with **`disallowedTools: Agent`** (no nested subagents), a **`maxTurns`** backstop, and the rule to **stop and emit `BLOCKED:`** rather than improvise when a command is denied. That instruction is reachable for the first time now: the guard hook's deny reason tells the agent to do exactly that, and the agent survives the denial to act on it, rather than stalling on an unanswered prompt.

**Cockpit rules.** The guard hook is not subagent-only: two rules apply to **any** caller — the cockpit's own session included — except an `/port:implement` operator worktree (`impl-<n>`, exempt because that skill's whole premise is running unguarded). Both exist because the cockpit itself violated the rail it was supposed to follow, under the same standing incentive to keep the pipeline moving:

- **Loop rule** (#120) — a `gh`/`git` call wrapped in a shell `for`/`while`/`until` loop is denied. Purely syntactic: a `for`/`while`/`until` keyword and a `do` keyword, each at a shell command position, on the command with every quoted span blanked out first (so prose inside a `-b`/`-m`/`--jq` argument, e.g. `"a loop for each item to do"`, can never trip it). One dead turn inside such a loop left a split state machine across three issues for four days, because one iteration lands and the rest die with the turn.
- **Gate rule** (#138) — a `gh pr edit`/`gh issue edit` call removing `<labels.needsHuman>` is denied unless a recent operator message names that item (`#N`, or `N` standalone, in one of the last 5 user messages of the calling session's own transcript). The cockpit cleared its own `needs human` escalation thirteen minutes after `revise-agent` set it, unprompted and on a false justification (*"now that the conflict is resolved"* — nothing had moved), so the gate needed a check the same machine could not talk itself past. An unreadable or absent transcript is treated as **unverifiable, not unauthorised** — it still allows the call, but logs it as `gate-clear` rather than silently as an `allow`, so an unverified clear is auditable rather than invisible.

Both rules check `who.isOperatorWorktree` first and allow immediately when it is true — an `/port:implement` session's own loop or gate-label edit is never in scope for either.

### What a dispatched agent can see

Committed `.claude/settings.json` and `.claude/port.config.json` both lag by one merge: a worktree is cut from `<integration>`, so whatever is on disk on some other branch — including the main checkout's own branch — is invisible to it until that branch merges. The cockpit's startup preflight (`skills/pipeline/SKILL.md`) is what turns this from a silent trap into a reported one: it refuses to tick when the main checkout itself carries neither file, and warns when it is on a non-integration branch.

A **plugin** addition needs three things lined up, not just the merge:

- **Declared** — `enabledPlugins` merged to `<integration>`.
- **Cached** — the declared `version` present under `~/.claude/plugins/cache/`, a **machine-local** copy no git operation in the repository touches.
- **Loaded** — the cockpit session started after both of the above.

**Merging declares a plugin; it does not install one.** Whether a dispatched subagent re-resolves project settings from its worktree or inherits the parent session's plugin set does not change this sequence, because the **cached** condition is machine-level either way — verified empirically, see `CONTRIBUTING.md` → "The three gates on a GitHub-sourced install".

The ordering rule that follows: **a plugin addition is its own prerequisite ticket.** Land it, merge it, refresh the install per `CONTRIBUTING.md`, restart the cockpit — then dependent tickets, which declare the plugin ticket via `blockedBy` (the cockpit already warns about unmerged blockers at opt-in).

**Denial visibility:** the guard hook logs every decision it makes — never an `allow` — to a gitignored `.agents/denials.log`. Each line is four tab-separated fields: `<iso8601>` `<decision>` `<who>` `<command-or-path>`, where `decision` is `deny`, `miss` (a non-subagent call that missed the allowlist — logged for visibility, never denied), `gate-clear` (an allowed, authorised removal of `<labels.needsHuman>` — **not a denial**, the audit record for a human gate being cleared), or `hook-error` (an internal failure, logged so a fail-open silently-broken hook is still visible); `who` is `port:<agent_type>` when the agent's type is known, else `subagent:<signal>`, else `session:<session_id>`; and `command-or-path` is whitespace-collapsed and truncated. A `deny` line can now carry a `session:` actor — the cockpit's own loop or gate rule firing against its own session, not a stage agent's allowlist miss, and worth reading differently: it means a rail held, not that a permission is missing. The cockpit reads it each tick and reports clusters of `deny` lines, breaking out any `session:`-actor line separately. A denied command now returns with the guard hook's reason rather than just erroring.

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

Rule: **every stage agent's first action is swapping its trigger label for its in-flight label.** Absence of a trigger label means the cockpit skips the item, so a tick can never double-dispatch. **An in-flight label means a stage *claimed* the item, never that an agent is still alive** — a crashed or killed agent leaves the label in place with nothing running. Liveness is a separate question, answered by `TaskList`, not by the label; see "Liveness" under Escalation. Recovery either way is re-applying the trigger label (`retry #N`).

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
| `approved` | `approved` | `review-agent` | terminal | Findings are at or under the current cycle's bar; a human merges. Removed only under the `## Check evidence` carve-out — a check on it has gone red since approval |
| `needsHuman` | `needs human` | Cockpit / `revise-agent` | gate | Cycle cap reached without convergence, or an ambiguous rebase conflict; the pipeline stops. Clears only via `unblock #N` — the guard hook denies any other removal, cockpit included |
| `refreshBranch` | `refresh branch` | Cockpit / human | trigger | *(`previewDatabase`)* Dispatch `revise-agent` in refresh mode |
| `refreshing` | `refreshing` | `revise-agent` | in-flight | *(`previewDatabase`)* Branch refresh underway; other labels are left in place |

## Stages and models

| Stage | Definition | Model | Why |
| --- | --- | --- | --- |
| Cockpit | `skills/pipeline/` | haiku (session) | Mechanical: queries, label swaps, dispatch, relaying |
| 0. Scope | `skills/scope/` | inherits session | Highest-leverage thinking; the human is in the conversation |
| 1. Plan | `agents/plan-agent.md` | `models.plan` | Design-rich planning; quality amplifies downstream |
| 2. Implement | `agents/impl-agent.md` | `models.impl` | Bulk of the code volume |
| 3. Review | `agents/review-agent.md` | `models.review` | Must catch real problems reliably |
| 4. Revise | `agents/revise-agent.md` | `models.revise` | Targeted fixes from a structured list |

When `docs.engineering` is set, all four workers read it before working, and `review-agent` treats it as a review dimension. When it is null they work from the plan, the ticket, and the surrounding code.

**Stages 2 and 4 have an operator variant.** Some tickets cannot be implemented by a dispatched agent at all, because the harness denies its edits under `sessionRequiredPaths`. Those two stages then run in the operator's own session via `/port:implement` — see "Session-required tickets".

## Permission model

Stage agents do real work — install packages, read CI logs, manage git in their worktree — so the allowlist grants broad categories and the deny list draws the safety line.

The installer (`/port:init`) writes both lists into the repository's `.claude/settings.json`, because **a plugin cannot ship permission rules**; they exist only in user or project settings. Templates live in the plugin's `templates/permissions.base.json`, with `<integration>` and `<production>` substituted into the push-deny rules. **Any permission change must be reflected there and here.**

Deny rules cover, at minimum: merging a pull request (the human merge gate is absolute), deleting issues or repositories, authentication commands, direct pushes to `<integration>` and `<production>`, package publication and login, and `find`'s command-executing and deleting flags. Push-deny needs **both** the bare-branch form (`git push * <branch>`, which also catches `--force` and `--delete`) **and** the refspec form (`git push *:<branch>`, which catches `HEAD:<branch>`, `<sha>:<branch>`, force-push, and delete). `find` needs both its leading-path and no-leading-path forms, because it defaults to searching `.` when given no path, so a bare invocation has no token for a leading-argument pattern to match.

Branch protection on `<integration>` and `<production>` is the authoritative backstop; the deny list is defence in depth.

### Known gap — shell redirection cannot be denied by pattern

A `permissions.deny` pattern cannot stop an allowlisted read-only command from writing files via `>`, `>>`, or `| tee`. Allow and deny matching operates on parsed command tokens — which is why an argument-based pattern like `find * -exec *` works — while shell redirection operators are consumed by the shell layer and never reach the string being compared. This was tested directly: a pattern anchored on the command name still let `echo hi > file` through.

**The mitigation is the allowlist itself**, which is why content emitters are excluded. The commands that remain emit search results, paths, or metadata rather than arbitrary content. **This narrows the bypass; it does not close it** — `grep -v x f > f` still strips lines, any allowed command can truncate a redirect target, and a broad `git` allow has always offered write primitives through `git apply` and `git checkout --`.

So "write files with the Write and Edit tools" is a **convention agents are expected to follow, not a technical guarantee** — and `plan-agent`'s and `review-agent`'s read-only status rests on them following it. **The guard hook described above is the `PreToolUse` deny this section used to ask for** — it inspects the raw Bash command string and returns a deny decision for a dispatched subagent's allowlist miss. What it does not close: shell redirection through an *allowed* command remains ungated, since the hook (like the harness's own matching) operates on parsed command tokens, and the redirection operators are consumed by the shell layer before either ever sees them.

### CI merge gate

> **Module: `approvalGate`.** Skip this section when the flag is false. Nothing else changes: `review-agent` still applies `approved` and the cockpit still announces it, but the merge gate is conversational rather than enforced.

A workflow gates pull requests into `<integration>` on the `approved` label, **but only when the pull request carries `claude`** (a job-level condition). Every other pull request — human, dependency bot — gets a skipped check run, which GitHub counts as satisfied, so it merges on its own merits.

This is deliberately **fail-open**: an unlabelled pipeline pull request is indistinguishable in CI from a human one and simply loses its gate. Nothing in the workflow can close that, so the mitigations live upstream — `impl-agent` passes `--label "claude"` at creation time so the gate is live on the first event, and the cockpit's **ungated sweep** reports any tracked pull request missing it.

**Never narrow the workflow's trigger to exclude a pull request.** A workflow that never runs creates no check run, leaving a required check pending forever. For the same reason, the workflow is scoped to `<integration>` only — release pull requests into `<production>` carry no pipeline labels and must not be gated.

The gate is only *enforced* if the check is registered as required in a branch ruleset. Creating that ruleset is an administrative action the installer deliberately does not take; until it exists the gate is advisory.

### Preview-database concurrency

> **Module: `previewDatabase`.** Skip this section when the flag is false. The cockpit runs no refresh pass, the two refresh labels are never created, `review-agent` has no deployment-check carve-out, and a failing deployment check is treated like any other failing check.

Some hosting setups give every open pull request a preview deployment backed by its own database branch, drawn from a finite project-wide pool. That pool bounds the pipeline, so every stage agent and the cockpit need the same picture of it.

- **Budget.** Count the total, subtract permanently-held branches (typically one per long-lived environment); the remainder is how many pull requests can hold a preview database at once. In-flight pull request count is bounded by that quota, not by agent capacity. Reclamation should be automatic — branch auto-delete on merge plus the provider's own sweep — and never a manual cleanup step. **Re-verify the numbers against the live inventory rather than trusting a written figure.**
- **Fingerprint.** The reliable signal is a dedicated check that fails when the project is at its cap. Read its output rather than inferring from a failed deployment. Fall back to the pattern "deployment check red while all other checks are green, on two or more open pull requests at once" — a single pull request red on its own stays ambiguous and should be treated as a real break.
  - **The budget check reports the project, not the pull request.** At capacity every open pull request's budget check goes red, including ones whose preview is fine, because the cap only blocks *new* branches. A red budget check plus a green deployment is a coherent state and never means that pull request is broken.
  - Deployment providers often surface as a **StatusContext** rather than a CheckRun in `statusCheckRollup`, so read `(.name // .context)` and `(.conclusion // .state)` to cover both.
  - The deployment check's own description is usually generic, naming neither the database provider nor the quota, and its remediation command may itself be deny-listed. Do not expect to read the deployment build log.
- **Degrade, do not halt.** A red deployment check from quota exhaustion is an **infrastructure condition, never a code finding**. `review-agent` must not raise it and must not route the pull request to `needs revision` over it; `revise-agent` must never try to fix it. Planning, implementation, review, and revision all continue normally; **only the merge gate waits**, because the deployment is a required status check.
- **Recovery.** Merging frees exactly one slot. The cockpit then labels **one** blocked `approved` pull request `refresh branch`, and `revise-agent` runs in refresh mode: rebase onto the base branch, force-push, nothing else. **The push is the redeploy** — no provider CLI, no retry subsystem. Triage line: **check the branch count before debugging the database layer.**

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
| **Issue** | `plan-agent` | First line of the plan body, before `## Overview` |
| **Pull request** | `/port:implement` | Directly under `Closes #N` in the description |

The literal string `SESSION REQUIRED` is the contract — **never reword it**; the reason after the colon is free text and is the part that generalizes. **There is deliberately no label.** The marker lives in the body on both surfaces, and the cockpit reads it from the `body` field of the trigger query it already runs, so the check costs no extra call and there is nothing to keep in sync.

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

**Mergeability precondition, ahead of the wait.** Read `mergeable` in the same `gh pr view` call (`headRefOid,statusCheckRollup,mergeable`). `CONFLICTING` means GitHub cannot build a merge ref for this pull request, so its check rollup **never concludes** — not slowly, not eventually, never — because the workflows that would populate it never run against a diff GitHub cannot construct. Without this precondition, the empty-rollup-is-pending rule above would park a conflicting pull request through the full bounded wait and then hand it to `<labels.needsHuman>` after roughly 30 minutes, misreporting a mechanical fact (the branches diverged) as an unexplained check timeout. So `CONFLICTING` is read **before** the bounded wait and short-circuits it: no verdict is formed, no check is waited on, and the pull request routes to `<labels.needsRevision>` with a `## Rebase required` comment instead (see "Rebase required" under Output formats) — `review-agent` at its own exit, the cockpit at the dispatch gate and the approved re-verify. `UNKNOWN` never blocks this precondition: GitHub has not computed mergeability yet, which is normal on a freshly opened or freshly pushed pull request, and the caller proceeds as if `MERGEABLE` — the read itself is what triggers GitHub to compute it.

**Bounded wait.** `gh pr checks <n> --repo <repo> --watch --interval 30` under a Bash timeout of `600000` ms, at most **3** times (~30 minutes total). `--watch`'s own output shape is not part of the contract — never parse it; after each wait, re-read `statusCheckRollup` directly. A timeout is a `BLOCKED:`, never a pass: a repository with genuinely slow checks parks here rather than getting a wrong answer.

**The `<labels.approved>` carve-out to the never-touch rail — exactly two authorising facts.** The cockpit may remove `<labels.approved>` from a pull request **only** when it has just read, on that pull request's **current** head: a red conclusion — other than the excused check above — for a named check, **or** `mergeable: CONFLICTING`. Either fact's announcement names what it rests on: the check and its conclusion, or the conflict. These are the **sole** exceptions to the never-touch rail; neither is a general licence to revisit terminal states, and neither is a guard-hook rule — the hook cannot observe "a check went red" or "GitHub reports a conflict," so the mechanical guard here is the layer-1 prose check plus the eval cases regression-testing each, not `agent-guard.mjs`. The conflicting case comments `## Rebase required`, never `## Approval withdrawn`, which contracts to name a check.

**No scheduled rebase — on demand, from `mergeable`, only.** A rebase force-pushes and re-runs every check on a pull request, so refreshing every open one whenever `<integration>` moves would multiply CI churn to prevent a condition `mergeable` already reports exactly and for free. Pull requests are therefore rebased **only** when GitHub itself reports `CONFLICTING` — at the review dispatch gate, at the approved re-verify, or inside `revise-agent`'s own rebase step — never on a schedule and never because the base "might have moved." This is a decision, not an omission: it was considered and rejected for the CI-churn cost above, and is recorded here so it is not re-litigated.

## Output formats

Defined once here; the stage agents follow these exactly.

### Writing style (every output)

Every plan, review, summary, and comment is written for a human scanning fast:

- **Bullets and short sentences over paragraphs** — one idea per bullet.
- **Never restate context the reader already has** (the ticket, a prior review, the diff) — reference it.
- **Omit empty sections** — no "N/A" or "None" filler; if a section does not apply, leave it out.
- **No meta-commentary** — do not describe the document itself.
- **Say it once** — never repeat a point across sections, or across body, inline, and summary.

### Implementation plan (`plan-agent` writes it into the issue body)

Appended below the ticket under a `---` then `## Implementation Plan`; revision mode replaces only that block. **Do not restate the ticket** — reference it. Fixed sections in this order; conditional ones appear **only when they apply**:

- **`SESSION REQUIRED` marker** *(only when a `sessionRequiredPaths` entry is touched)* — the first line, before `## Overview`.
- **## Overview** — 2–4 sentences: what, why, the approach.
- **## Changes** — files to create or modify, one bullet each: `` `path` — one-line reason ``.
- **## Implementation** — ordered `- [ ]` checkboxes, one line each; fold validation, states, and error-model notes into the step they belong to.
- **## Data & contracts** *(only if a schema or a server-side contract changes)* — the change, and per entry point its validation and authorization.
- **## UX states** *(only if there is a user interface)* — loading, empty, error, plus key copy.
- **## Testing** — human-runnable manual steps as `- [ ]`, feeding the pull request's testing plan. A step whose only reachable path is `sessionRequiredPaths` and did not already trigger the whole-plan marker takes the form `- [ ] **operator-only** — <step> (<why>)`.
- **## Risks / notes** *(optional)* — only real, non-obvious ones.

Most plans fit on one screen. No preamble, no restated goal, no empty sections.

### Reviews and revisions

The code review is a **real GitHub pull request review** (`gh api …/pulls/<pr>/reviews --input`): **inline line comments carry the findings**; the body is a one-line verdict. **Event:** `COMMENT` when the reviewer is the author (common case — same account; GitHub forbids `REQUEST_CHANGES`/`APPROVE` on your own pull request), otherwise `REQUEST_CHANGES` or `APPROVE`. The pipeline **label** is the real control signal regardless.

**Findings live on the threads, not in a summary.** A resolved review thread *is* the log entry — collapsed and out of the way until expanded. So a finding is never re-narrated cycle after cycle, and "what is still open" is GitHub's unresolved-conversation count.

- **Review body = title plus one line.** `## Code Review — Cycle <n> · <verdict>`, `<verdict>` one of `approved`, `needs revision`, or `blocked — checks pending` (keep the literal `Code Review` — the cockpit counts it), then a single counts line, e.g. `2 open — 1 🔴 Critical, 1 🟠 Medium (see inline)`. Nothing else. **Only exception:** a finding that cannot anchor to a diff line has no thread, so it goes in the body with a `blob/<headRefOid>` permalink.
- **Each finding is one inline comment** on a diff line: `**R<n>-<sev><id>** <emoji> — <problem>. Fix: <one line>.` Stable ID `R<cycle>-<sev><id>`; severities 🔴 Critical · 🟠 Medium · 🟡 Low · ⚪ Nit. Inline comments are **new actionable findings only** — never status.
- **Escalating bar — what blocks rises with the cycle.** Pass 1 polishes everything, later passes converge: **cycle 1** any finding blocks; **cycle 2** Low and above (Nit does not); **cycle 3+** Critical and Medium only. A nit introduced during a revision cannot re-trigger at cycle 2 or later. The cockpit's cap is `reviewCycleCap` with Critical or Medium still open, which routes to `needs human`. A red required check, other than the `## Check evidence` carve-out, is **always** Critical, at every cycle — never downgraded to fit a later cycle's bar.
- **Inline anchoring.** A comment is accepted only on a line **in the diff** — map it from `gh pr diff` hunk headers (added and context lines → `side:"RIGHT"`, new-version line; deletions → `side:"LEFT"`, old-version line). If the reviews API returns 422 for an unresolvable line, **resubmit with `comments:[]`** and list those findings in the body with permalinks, so a review always lands.
- **Revision resolves threads, it does not summarize.** After pushing fixes, for each **fixed** finding reply `Fixed in <sha>` on its thread and resolve it via GraphQL (`addPullRequestReviewThreadReply` then `resolveReviewThread`), matched by ID; **genuinely-skipped** threads get a one-line reason and stay open. Then one short comment per cycle, or none: `## Revision — Cycle <n>` plus a single line `fixed <ids> · skipped <ids> · <sha>`, appending `· rebase: <file> (<strategy>)` if a conflict was auto-resolved. The detail line may instead open `check <name> · <sha>` for a check-fix cycle — see `revise-agent.md` step 1 — with no `fixed`/`skipped` segment, since there are no threads to resolve.
- **Other comments** — `## Pipeline Escalation` (revise: ambiguous rebase), `## Blocker` (impl: on the issue), `## Gate cleared` (cockpit: on the pull request, at `unblock #N`), `## Approval withdrawn` (cockpit: on the pull request, when a check goes red after approval — see "The `<labels.approved>` carve-out" in `## Check evidence`), and `## Rebase required` (cockpit or `review-agent`: when `mergeable` reads `CONFLICTING` — see "Rebase required" below) stay short: what is blocked/cleared/withdrawn/needed and the decision required, via `--body-file`.

### Approval withdrawn (cockpit writes it via `--body-file`)

Posted the same tick the cockpit routes an approved pull request back to `<labels.needsRevision>` per the `## Check evidence` carve-out. Short, no restated context:

```
## Approval withdrawn
`<check-name>` went **<conclusion>** on `<head-sha>` after approval. <link>
```

Names the check, its conclusion, its link, and the head SHA the conclusion belongs to — the four facts that authorise the removal, so the record stands on its own without the cockpit's own reasoning attached.

### Rebase required (cockpit and `review-agent` write it via `--body-file`)

Posted whenever `mergeable` reads `CONFLICTING` — at the cockpit's dispatch gate, at its approved re-verify, or at `review-agent`'s own exit — the moment a pull request routes to `<labels.needsRevision>` for this reason rather than for review findings. Two lines, no restated context:

```
## Rebase required
Conflicts with `<base>` at `<head-sha>` — GitHub can't build a merge ref, so no checks ran on this diff.
```

Names the base branch and the head SHA the conflict was read against — enough for `revise-agent` to enter rebase-only mode (see `revise-agent.md`) without re-deriving anything, and enough for a human reading the thread to know the pipeline never had checks to go on.

### Pull request description (`impl-agent` writes it via `--body-file`)

`Closes #N` · **## Summary** (what was built and the approach) · **## Changes** (notable files and areas) · **## Testing plan** — reproducible **manual** steps as a `- [ ]` checklist a human runs before merge, covering happy path, error and empty and edge cases, and any authorization roles, derived from the issue's testing section · **## Automated checks** (the `commands.checks` that were run) · **## Notes** (schema changes, risks, follow-ups).

Any `- [ ] **operator-only**` step in the issue's `## Testing` carries into `## Testing plan` **verbatim** — the prefix is the only thing telling the human which box only they can tick.

The pull request is **assigned to the issue's assignee**, falling back to `@me` when the issue has none — never a hardcoded login. The pull-request-stage queries are assignee-filtered too, so a pull request with the wrong owner is invisible to the cockpit that shepherded its issue.

### Commit messages

Write the message to `.temp/commit-msg.txt` and `git commit -F .temp/commit-msg.txt` — **never** inline multi-line `-m … -m …`, which collapses on Windows and drops the subject and co-authorship. Format: subject `#N <imperative lowercase summary>` **under 80 characters, no trailing period**; an optional short body only when the *why* is not obvious (blank line, wrap around 72, a few lines at most); then a blank line and the co-authorship trailer naming the model from `models`.

## Escalation

- **Review and revise not converging** — before each revise dispatch the cockpit counts `## Code Review` comments; at `reviewCycleCap` with Critical or Medium still found it labels `needs human`, comments, and stops dispatching for that item.
- **Implementation blocker** — `impl-agent` comments `## Blocker`, labels `blocked`, and reports `BLOCKED:`; the cockpit relays and resumes the same agent with the human's decision.
- **Rebase conflict during revision** — `revise-agent` resolves everything inferrable and escalates only the genuinely ambiguous hunks as numbered decision requests; it aborts the whole rebase, comments `## Pipeline Escalation`, and labels `needs human` whenever any hunk is ambiguous or on the never-touch list. `unblock #N` relays the options and re-dispatches with the operator's selections.
- **Plan questions** — `plan-agent` never guesses: it returns `QUESTIONS FOR HUMAN:` and the cockpit relays, then resumes it with answers.
- **No verdict formed while checks are pending** — `review-agent` waits, bounded, for every check on the head commit to conclude before posting; a timeout is `blocked — checks pending`, never a pass. See `## Check evidence`.
- **A check goes red after approval** — the cockpit re-verifies every `<labels.approved>` pull request each tick and, under the sole carve-out in `## Check evidence`, routes it back to `<labels.needsRevision>` with `## Approval withdrawn` naming the check.
- **Stalled or usage-limited agent** — an in-flight label with no live `TaskList` entry means the agent crashed or hit a usage limit, not that work is proceeding; see "Liveness" for how the cockpit tells the two apart and responds.
- **A pull request cannot be reviewed against a diff CI never validated** — the cockpit reads `mergeable` at the dispatch gate and at the approved re-verify, and `review-agent` reads it again at its own exit; `CONFLICTING` forms no verdict, dispatches no review, and routes to `<labels.needsRevision>` with `## Rebase required` instead. See `## Check evidence` → "Mergeability precondition" and "Rebase required" under Output formats.

### Liveness

An in-flight label is a claim, not a heartbeat — nothing about it tells the cockpit whether an agent is still running. Every tick, the cockpit queries the in-flight labels (`planning`, `in progress`, `reviewing`, `revising`, and `refreshing` under `previewDatabase`) and cross-checks the result against `TaskList`, matching entries by the dispatch `description` (`"<stage> #<n>"`). Four termination classes distinguish what a completed or vanished agent means:

| Class | Signature | Response |
| --- | --- | --- |
| **Completed** | Agent finished normally, final message available | Relay its message per the relay loop; the labels it set drive the next tick |
| **Failed** | Agent errored before finishing | Item stays at its in-flight label with no matching `TaskList` entry — see the two classes below |
| **Stopped / killed** | Operator ran `stop #N`/`halt`, or `TaskStop` | Label already reset to trigger by the stop command; nothing further to report |
| **Usage limit** | A `session limit` message, typically across every in-flight agent at once | Takes precedence over the two classes below: do not redispatch and do not change models; reset each affected item's in-flight label to its trigger label (one `gh` call per item), report the reset time verbatim, and schedule the next wakeup just after it |

**An in-flight item with no live `TaskList` entry splits into exactly two classes, proven by this session's own dispatch log (`.temp/dispatch-log.md`, written fresh at startup and rewritten at every dispatch and every liveness transition) — never by guessing from how long it has sat there:**

| Class | Proof | Response |
| --- | --- | --- |
| **Dispatched this session, now dead** | The log carries a row for the item | **Provably dead — safe to auto-reset.** First unmatched tick: mark the row `suspect`, report, change nothing. Still unmatched the tick after: reset the label to its trigger (batched by current→trigger pair, one `gh` call per group, re-queried to confirm), mark the row `reset`. **At most one automatic reset per item per session** (the log's `Resets` column) — a crash loop reports instead of burning the session. |
| **No dispatch record** | The log carries no row — a prior session's work, or another cockpit's | **This cockpit cannot prove anything about it — report-only, forever.** Never reset it automatically; a restarted cockpit's fresh (empty) dispatch log must not stampede a co-operator's live agents back to their trigger labels. `retry #N` is the human's route. |

Reset is never immediate: the one-tick `suspect` debounce, the dispatch-log requirement, and the once-per-session cap are three independent guards against the one real risk — resetting an item whose agent is actually still alive, which would double-dispatch against one branch. Every failure direction points toward report-only. A reset item redispatches on the **next** tick (dispatch is step 4, liveness is step 5, in that order), never the same one. Never reset `<labels.approved>` or `<labels.needsHuman>` — they are not in-flight labels. A `SESSION REQUIRED` item at an in-flight label is never reported as a stall — it is the operator's own `/port:implement` session, and it can never carry a dispatch-log row by construction.

The log itself is a gitignored `.temp/dispatch-log.md`, overwritten fresh at startup — the overwrite alone is what scopes it to one session, no clock or session ID needed. A file whose header names a different repository is treated as absent. Two cockpits sharing one checkout clobber each other's copy, which degrades both to report-only — the safe direction, never a false reset.

If `TaskList` cannot be correlated to numbers at all, report the in-flight set alongside the running-agent count and say the match is uncertain rather than guessing which is which.

### Rebase conflict protocol (`revise-agent`)

When `git rebase origin/<base>` hits conflicts, `revise-agent` is biased **toward resolving**: it resolves everything inferrable and escalates only what is genuinely ambiguous, as a set of concrete decisions rather than a narrated dump. **Atomicity and preservation are separate properties.** Atomicity is unchanged — abort the **entire** rebase on any ambiguity, and never push a half-rebased branch. What must never be discarded is the *classification* itself: it is deterministic, so the auto-resolved set is re-derived identically on the next attempt, and the escalation records it so the operator can see what will be reapplied.

This applies **unchanged in refresh mode**: a conflict is a real blocker and still escalates, while quota alone never does.

1. **Inspect** — `git diff --name-only --diff-filter=U` lists conflicted files. Read the conflict markers with Grep or Read.
2. **Classify each conflict:**

   | Auto-resolvable ✓ | Escalate ✗ |
   | --- | --- |
   | Both sides' changes are in clearly separate, non-overlapping line ranges | Both sides modified the same function body, expression, or schema field |
   | Generated files and lockfiles | Database migration files — never auto-resolve a migration |
   | Each side added a different import or export, with no line overlap | Type definitions or constants where both sides changed the same key |
   | The other side made a whitespace or formatting-only change in our area | Logic changes on the same lines from both sides |
   | One side deleted a block entirely that the other did not touch | Any conflict where accepting one side would silently drop the other's logic |
   | Both sides append distinct entries to the same list, set, or table → **take the union** | — |
   | Both sides add distinct sections or rows under the same heading → **keep both, in a deterministic order** (base's first, then ours) | — |
   | One side restructures a block the other only added to → **apply the addition inside the new structure** | — |

   **The never-auto-resolve list is unchanged**: `sessionRequiredPaths`, database migration files, and environment or build configuration always escalate, however simple the diff looks — and any conflict where accepting one side would silently drop the other's logic escalates regardless of which row it otherwise resembles.

3. **If all are auto-resolvable** — resolve each with Edit or Write, removing every conflict marker, then `git add "<path>"` (quoted), then `git -c core.editor=true rebase --continue` (never a bare `--continue`, which may open an editor). For a lockfile, prefer taking the base's version and regenerating over hand-merging. A rebase may pause repeatedly — re-run this protocol at each pause. In the revision comment, list each resolved file and the strategy used.
4. **If any is ambiguous** — `git rebase --abort` immediately (abort the whole rebase; never leave a half-rebased state). Comment `## Pipeline Escalation`: a one-line summary (`<k> conflicts — <a> resolved automatically, <b> need a decision`), an `### Auto-resolved (reapplied on the next attempt)` list of `` `path` — <strategy> ``, then one `### D<n> — \`path\`` block per ambiguous hunk — **not** a raw conflict-marker dump — containing what each side (**ours**/**theirs**) is trying to achieve in one line each, a two-or-three-row options table with `Keeps`/`Loses` columns (typically **A take ours** · **B take theirs** · **C** a specific described combination), and a bolded `**Recommendation: <letter>** — <reason>`. IDs are `D1..Dn`, restarting at `D1` in each escalation comment. Then label `needs human` and stop — the operator picks a direction with `unblock #N`, never edits a file themselves.
5. **On the next attempt** — read the newest `## Gate cleared` comment (if newer than the newest `## Pipeline Escalation`) for its `### Rebase decisions` lines (`` - D<n> `path` — **<letter> <label>** ``) and apply each recorded decision to its matching hunk alongside every auto-resolvable one, in a single pass. A decision whose hunk no longer exists (the base moved again) is dropped and noted in the revision comment; a **new** ambiguous hunk with no recorded decision escalates again with fresh `D1..Dn` IDs.

## Stopping and draining

The pipeline runs autonomously once started; these cockpit commands are the clean off-switch:

- **`drain` / `pause`** — finish in-flight work, start nothing new (stops dispatch **and** wakeups). **`resume`** restarts ticking.
- **`stop #N`** — halt one item: drop its trigger label and `TaskStop` its in-flight agent, resetting the label so it can be retried.
- **`stop` / `halt`** — drain, `TaskStop` all running agents, and reset their labels.
- **`unblock #N`** — the **only** route off `<labels.needsHuman>`. Not a variant of `retry`/`resume`: those re-apply a trigger for an in-flight label and never touch this gate. `unblock` reads the escalation comment, asks which way to route (back to revision or back to review), comments the clear onto the pull request, then swaps the label — the guard hook denies the same removal from any other route, so this command is the one place it succeeds.

Closing the cockpit session also halts dispatch, since it is the only dispatcher, but cuts off in-flight agents mid-run — prefer `drain` for a graceful stop.

## Recovery runbook

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unknown skill: port:init` right after installing | The session resolved its plugins at startup, before the install | Start a new session in the same directory — the install itself is fine |
| Item stuck in an in-flight label with no agent running | Agent crashed or the session closed mid-flight | `retry #N` in the cockpit, or re-apply the trigger label |
| Nothing dispatches for an item | It has no trigger label (paused, in-flight, or gated) | `status` shows where it is; `resume #N` re-applies the right trigger |
| Nothing dispatches **and** `status` does not list it at all | It is unassigned, or owned by another operator — queries are assignee-filtered | The tick's unowned sweep reports it; claim it with `work on #N` |
| An item sits at a trigger label and nothing dispatches | Its body carries `SESSION REQUIRED` — the cockpit never dispatches those | Open a named session and run `/port:implement <n>` |
| No check runs at all on a new push, while the deployment still runs | The pull request conflicts with its base, so GitHub cannot build the merge ref that `pull_request` workflows run against | `gh pr view <n> --json mergeable` reports `CONFLICTING`. Rebase onto the base and force-push |
| The approval check shows **Skipped** on a pipeline pull request | It is missing the `claude` label, so the gate is inactive | Add the label; the `labeled` event re-evaluates the job condition |
| Deployment check red on two or more open pull requests while other checks are green | *(`previewDatabase`)* The preview database pool is at its cap | Nothing to debug in the code. Merging any pull request frees a slot; force one with `refresh #N` |
| Orphan worktree directories accumulating (registered worktrees for finished items are removed automatically, each tick, up to a per-tick cap) | Agents cut off mid-run; on Windows the harness de-registers a worktree but cannot delete a populated dependency tree | Run **`/port:worktree-clean`** from the main checkout |
| Cockpit sits idle and never ticks again | A tick ended without calling `ScheduleWakeup` — the closing line was narrated instead of the call being made | Say anything to it to force a tick; the tick's closing line is only trustworthy once it is the record of a real `ScheduleWakeup` call |
| An agent stopped with `BLOCKED:` or hit `maxTurns` | A clean stop by design, not a crash | Resolve the blocker, or widen scope or permissions, then `retry #N` |
| A stage misbehaved and you want to run it by hand | — | Mention the subagent directly, or run a whole session as it |
| Cockpit session closed | All state is in labels | Start `/port:pipeline` again; it resumes from the labels |
| Labels changed manually on GitHub | Fine — labels are the source of truth | The next tick acts on whatever the labels say |
| A permission change was merged but agents still hit denials | A worktree carries the *committed* settings | Confirm it merged to `<integration>`; agents pick it up on their next fresh worktree |
| `/port:pipeline` refuses to start | The checked-out branch carries no `.claude/port.config.json`, or no `permissions.allow` | Check out the branch the harness was installed on, or run `/port:init` on this one |
| A plugin was installed and merged, but agents behave as if it is absent | Merging declares a plugin, it does not install one | Update the main checkout, refresh the install per `CONTRIBUTING.md`, restart the cockpit |
| An item parked at an in-flight label, this session dispatched it, and no matching `TaskList` entry | The dispatched agent failed or the session closed mid-flight | The liveness cross-check reports it **suspect**, then auto-resets it to its trigger label the tick after — `retry #N` works too, immediately |
| An item parked at an in-flight label with no matching `TaskList` entry, and this session's dispatch log has no row for it | A prior session's (or another cockpit's) work — this session cannot prove it is dead | Reported every tick as "in flight with no dispatch record," never touched automatically; `retry #N` resets it by hand |
| An item was auto-reset once and stalls again in the same session | The once-per-session cap held — a crash loop reports rather than resetting forever | `retry #N` for another attempt; restarting the cockpit clears the cap (fresh dispatch log) |
| Every dispatched agent failed at once, all reporting a session-limit message | The operator's usage window was exhausted | The cockpit parks each affected item back at its trigger label and schedules the next wakeup just after the reported reset time; nothing to retry manually |
| The cockpit says a gate clear was denied | Correct behaviour — the guard hook denies removing `<labels.needsHuman>` unless an operator instruction just named that item | Say `unblock #N` if you actually mean to clear it |
| A batch label change moved only some of the items | A partial application — the same failure mode a shell loop used to hide | The re-query the cockpit runs after every multi-item change reports exactly which one did not move; re-issue for the remainder |
| A pull request was approved and then moved back to `needs revision` | A check on it went red after approval, or `mergeable` reads `CONFLICTING` | The `## Approval withdrawn` or `## Rebase required` comment names why; revision dispatches this tick |
| `review-agent` stopped without a verdict | Checks never concluded within the bounded wait | The pull request is at `<labels.needsHuman>`; `unblock #N` is the route |
| A pull request at `ready for review` never gets reviewed, and the cockpit reports it conflicting | `mergeable` reads `CONFLICTING` — GitHub never ran checks on this diff | The cockpit posts `## Rebase required` and moves it to `needs revision`; `revise-agent` rebases and pushes it back to `ready for review` automatically |

## Reading current state without the cockpit

```bash
gh issue list --repo <repo> --label "plan review"
gh issue list --repo <repo> --label "blocked"
gh pr list --repo <repo> --label "approved"
gh pr list --repo <repo> --label "needs human"
```

These are deliberately **unfiltered** — a global view across all operators, unlike the cockpit's `--assignee "@me"` ticks. Add `--assignee "<login>"` for one operator's slice, or `--search "no:assignee"` to find unowned items.
