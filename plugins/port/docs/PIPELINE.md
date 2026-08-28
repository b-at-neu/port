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

Then talk to it: `work on #142` · `scope out a notifications feature` · `status` · `pause #142` · `retry #142` · `drain` · `resume` · `stop #142`.

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

A non-allowlisted command must **auto-deny** (never prompt the human), or every stray command interrupts the operator. Stage agents therefore run **`permissionMode: dontAsk`** (auto-deny anything not allowlisted, no prompt) and the **cockpit session must run in `default` mode** — a parent in `acceptEdits`, `bypassPermissions`, or `auto` overrides the subagent's `dontAsk`, and the prompts start surfacing to the operator again. Because `dontAsk` only runs allowlisted actions, the allowlist must also grant **`Edit(**)` and `Write(**)`** so impl and revise can edit source at all; file edits are not auto-accepted under `dontAsk`.

The model is **broad allow, authoritative deny**: allow whole dev-command categories, and use the `deny` list as the real safety surface for dangerous or interactive commands. Deny beats allow at every scope. A worktree is a checkout of `<integration>`, so it carries the *committed* settings — **permission changes take effect for dispatched agents only after they merge.**

Agents also run with **`disallowedTools: Agent`** (no nested subagents), a **`maxTurns`** backstop, and the rule to **stop and emit `BLOCKED:`** rather than improvise when a command is auto-denied.

**Denial visibility:** a `PermissionDenied` Bash hook records every command the harness actually denied — the decision itself, never a prediction of it — to a gitignored `.agents/denials.log`. Each line is five tab-separated fields: `<iso8601>` `<actor>` `<mode>` `<reason>` `<command>`, where `actor` is `agent:<agent_type>:<agent_id>` for a dispatched subagent or `session:<session_id>` for the main thread, and `reason`/`command` are whitespace-collapsed and truncated. The cockpit reads it each tick and reports clusters, so systemic denials are visible without prompting. Logging only — it never blocks. The event is new (CLI 2.1.238); on an older CLI the hook never fires, so silence there means no visibility, not health.

### File-based GitHub I/O

Agents never pass large markdown (plans, reviews, comments) as an inline `--body "..."` argument — shell quoting of backticks and code fences fails cross-platform. They write the payload to `.temp/` (gitignored) and use `gh ... --body-file`. The same applies to the cockpit's escalation comments.

### Operating rules (all stage agents)

Canonical rules every stage agent follows. A Bash command matches the allowlist only if it **starts with an allowlisted binary AND parses cleanly**; otherwise it falls through to a prompt that a background agent auto-denies.

- **Check the repository's `.claude/settings.json` for what is actually allowed** rather than guessing from memory. The base allowlist grants `gh`, `git`, the repository's package manager, a set of read-only inspection commands, and `Edit(**)`/`Write(**)`; `extraAllow` adds anything else the repository needs.
- **Content emitters are deliberately absent from the allowlist** — `echo`, `cat`, `head`, `tail`, `cut`, `diff`, `true`. Their whole purpose is emitting bytes to stdout, and a redirect turns each into a clean file-write primitive. Use the Read tool instead of `cat`/`head`/`tail`, and Write/Edit instead of `echo >`. See "Known gap" under the permission model for why this is the control rather than a deny rule.
- **Inspect with tools, not the shell** — Read, Grep, and Glob are the default for reading, searching, and listing (cheaper, gitignore-aware, skips dependency directories). The allowlisted shell commands exist for what those tools cannot do — piping, chaining, one-off counts — not as a first resort. Scope Glob to source directories; prefer Grep over a root-level `**/*`, which descends dependency directories and times out.
- **Run commands bare** — no `cd … && …` and no `ENV=val cmd` prefix; both move the start token off the binary, so `GIT_EDITOR=true git …` misses `Bash(git *)`. For a non-interactive git editor use `git -c core.editor=true …`. The same applies to multi-line Bash calls, `for`/`while` loops, and subshells — each moves the first token off the allowlisted binary exactly as `cd` does, so issue one command per Bash call. **Never `sh -c '…'` or `bash -c '…'`** — a generic command-execution escape hatch that could smuggle any denied command through as a string argument.
- **Quote every path argument.** Parentheses and brackets are shell-special, and appear in real source paths. Use cwd-relative paths with forward slashes, never an absolute or base-repository path. `git add -A` avoids enumerating them.
- **Write files with the Write and Edit tools** at cwd-relative paths — never shell redirection (`cat >`, `printf >`, `echo >`, heredocs). Delete tracked files with `git rm`.
- **GitHub I/O is file-based** — large markdown goes to `.temp/` via `gh … --body-file`/`--input`, never inline `--body "…"`. Extract data with `gh … --json … --jq '…'`, never piped to an interpreter.
- **When auto-denied, stop — do not improvise.** A denied command just errors, with no prompt, under `dontAsk`. Do not retry or route around it: **emit `BLOCKED: <exact denied command + what you needed>`** so the cockpit surfaces it. Never spawn subagents.

## Label lifecycle

Rule: **every stage agent's first action is swapping its trigger label for its in-flight label.** Absence of a trigger label means the cockpit skips the item, so a tick can never double-dispatch. A crashed agent leaves the item parked in an in-flight label; recovery is re-applying the trigger label (`retry #N`).

### Issue labels

| Label | Set by | Type | Meaning |
| --- | --- | --- | --- |
| `claude` | Cockpit (at opt-in) | marker | The pipeline is handling this ticket |
| `ready` | Cockpit (at opt-in) | trigger | Dispatch `plan-agent` |
| `planning` | `plan-agent` | in-flight | Plan being researched and written |
| `plan review` | `plan-agent` | gate | Plan written — awaiting human approval in the cockpit |
| `plan changes requested` | Cockpit (human feedback) | trigger | Dispatch `plan-agent` in revision mode |
| `plan approved` | Cockpit (human approval, or `auto plan`) | trigger | Dispatch `impl-agent` |
| `auto plan` | Cockpit (at opt-in) | marker | Plan gate skipped: `plan review` auto-approved |
| `in progress` | `impl-agent` | in-flight | Implementation underway |
| `pr opened` | `impl-agent` | terminal | Pull request open; remaining state tracked there |
| `blocked` | `impl-agent` | gate | Needs a human decision; details in an issue comment |

### Pull request labels

| Label | Set by | Type | Meaning |
| --- | --- | --- | --- |
| `claude` | `impl-agent` (at `gh pr create`) | marker | The pipeline owns this pull request |
| `ready for review` | `impl-agent` / `revise-agent` | trigger | Dispatch `review-agent` |
| `reviewing` | `review-agent` | in-flight | Review underway |
| `needs revision` | `review-agent` | trigger | Dispatch `revise-agent` (subject to the cycle cap) |
| `revising` | `revise-agent` | in-flight | Fixes underway |
| `approved` | `review-agent` | terminal | Findings are at or under the current cycle's bar; a human merges |
| `needs human` | Cockpit / `revise-agent` | gate | Cycle cap reached without convergence, or an ambiguous rebase conflict; the pipeline stops |
| `refresh branch` | Cockpit / human | trigger | *(`previewDatabase`)* Dispatch `revise-agent` in refresh mode |
| `refreshing` | `revise-agent` | in-flight | *(`previewDatabase`)* Branch refresh underway; other labels are left in place |

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

So "write files with the Write and Edit tools" is a **convention agents are expected to follow, not a technical guarantee** — and `plan-agent`'s and `review-agent`'s read-only status rests on them following it. Closing it properly needs a *new*, separate `PreToolUse` hook that inspects the raw command string and returns a deny decision. That is not the denial-visibility hook described above: this one fires on `PermissionDenied`, only records a decision the harness already made, and cannot gate anything itself.

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
- **## Testing** — human-runnable manual steps as `- [ ]`, feeding the pull request's testing plan.
- **## Risks / notes** *(optional)* — only real, non-obvious ones.

Most plans fit on one screen. No preamble, no restated goal, no empty sections.

### Reviews and revisions

The code review is a **real GitHub pull request review** (`gh api …/pulls/<pr>/reviews --input`): **inline line comments carry the findings**; the body is a one-line verdict. **Event:** `COMMENT` when the reviewer is the author (common case — same account; GitHub forbids `REQUEST_CHANGES`/`APPROVE` on your own pull request), otherwise `REQUEST_CHANGES` or `APPROVE`. The pipeline **label** is the real control signal regardless.

**Findings live on the threads, not in a summary.** A resolved review thread *is* the log entry — collapsed and out of the way until expanded. So a finding is never re-narrated cycle after cycle, and "what is still open" is GitHub's unresolved-conversation count.

- **Review body = title plus one line.** `## Code Review — Cycle <n> · <verdict>` (keep the literal `Code Review` — the cockpit counts it), then a single counts line, e.g. `2 open — 1 🔴 Critical, 1 🟠 Medium (see inline)`. Nothing else. **Only exception:** a finding that cannot anchor to a diff line has no thread, so it goes in the body with a `blob/<headRefOid>` permalink.
- **Each finding is one inline comment** on a diff line: `**R<n>-<sev><id>** <emoji> — <problem>. Fix: <one line>.` Stable ID `R<cycle>-<sev><id>`; severities 🔴 Critical · 🟠 Medium · 🟡 Low · ⚪ Nit. Inline comments are **new actionable findings only** — never status.
- **Escalating bar — what blocks rises with the cycle.** Pass 1 polishes everything, later passes converge: **cycle 1** any finding blocks; **cycle 2** Low and above (Nit does not); **cycle 3+** Critical and Medium only. A nit introduced during a revision cannot re-trigger at cycle 2 or later. The cockpit's cap is `reviewCycleCap` with Critical or Medium still open, which routes to `needs human`.
- **Inline anchoring.** A comment is accepted only on a line **in the diff** — map it from `gh pr diff` hunk headers (added and context lines → `side:"RIGHT"`, new-version line; deletions → `side:"LEFT"`, old-version line). If the reviews API returns 422 for an unresolvable line, **resubmit with `comments:[]`** and list those findings in the body with permalinks, so a review always lands.
- **Revision resolves threads, it does not summarize.** After pushing fixes, for each **fixed** finding reply `Fixed in <sha>` on its thread and resolve it via GraphQL (`addPullRequestReviewThreadReply` then `resolveReviewThread`), matched by ID; **genuinely-skipped** threads get a one-line reason and stay open. Then one short comment per cycle, or none: `## Revision — Cycle <n>` plus a single line `fixed <ids> · skipped <ids> · <sha>`, appending `· rebase: <file> (<strategy>)` if a conflict was auto-resolved.
- **Other comments** — `## Pipeline Escalation` (revise: ambiguous rebase) and `## Blocker` (impl: on the issue) stay short: what is blocked and the decision needed, via `--body-file`.

### Pull request description (`impl-agent` writes it via `--body-file`)

`Closes #N` · **## Summary** (what was built and the approach) · **## Changes** (notable files and areas) · **## Testing plan** — reproducible **manual** steps as a `- [ ]` checklist a human runs before merge, covering happy path, error and empty and edge cases, and any authorization roles, derived from the issue's testing section · **## Automated checks** (the `commands.checks` that were run) · **## Notes** (schema changes, risks, follow-ups).

The pull request is **assigned to the issue's assignee**, falling back to `@me` when the issue has none — never a hardcoded login. The pull-request-stage queries are assignee-filtered too, so a pull request with the wrong owner is invisible to the cockpit that shepherded its issue.

### Commit messages

Write the message to `.temp/commit-msg.txt` and `git commit -F .temp/commit-msg.txt` — **never** inline multi-line `-m … -m …`, which collapses on Windows and drops the subject and co-authorship. Format: subject `#N <imperative lowercase summary>` **under 80 characters, no trailing period**; an optional short body only when the *why* is not obvious (blank line, wrap around 72, a few lines at most); then a blank line and the co-authorship trailer naming the model from `models`.

## Escalation

- **Review and revise not converging** — before each revise dispatch the cockpit counts `## Code Review` comments; at `reviewCycleCap` with Critical or Medium still found it labels `needs human`, comments, and stops dispatching for that item.
- **Implementation blocker** — `impl-agent` comments `## Blocker`, labels `blocked`, and reports `BLOCKED:`; the cockpit relays and resumes the same agent with the human's decision.
- **Rebase conflict during revision** — `revise-agent` attempts autonomous resolution per the protocol below; it aborts, comments `## Pipeline Escalation`, and labels `needs human` **only** when a conflict is ambiguous or on the never-touch list.
- **Plan questions** — `plan-agent` never guesses: it returns `QUESTIONS FOR HUMAN:` and the cockpit relays, then resumes it with answers.

### Rebase conflict protocol (`revise-agent`)

When `git rebase origin/<base>` hits conflicts, `revise-agent` resolves the structurally unambiguous ones and escalates the rest. **Fail closed:** if any single conflict is ambiguous or on the never-touch list, abort the **entire** rebase and escalate — never partially resolve, and never let an auto-resolve silently drop a side's logic.

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

3. **If all are auto-resolvable** — resolve each with Edit or Write, removing every conflict marker, then `git add "<path>"` (quoted), then `git -c core.editor=true rebase --continue` (never a bare `--continue`, which may open an editor). For a lockfile, prefer taking the base's version and regenerating over hand-merging. A rebase may pause repeatedly — re-run this protocol at each pause. In the revision comment, list each resolved file and the strategy used.
4. **If any is ambiguous** — `git rebase --abort` immediately (abort the whole rebase; never leave a half-rebased state), comment `## Pipeline Escalation` listing each ambiguous file and hunk, both sides of each conflict, and why autonomous resolution was not safe; then label `needs human` and stop.
5. **Never auto-resolve** anything matching `sessionRequiredPaths`, database migration files, or environment and build configuration — escalate regardless of apparent simplicity.

## Stopping and draining

The pipeline runs autonomously once started; these cockpit commands are the clean off-switch:

- **`drain` / `pause`** — finish in-flight work, start nothing new (stops dispatch **and** wakeups). **`resume`** restarts ticking.
- **`stop #N`** — halt one item: drop its trigger label and `TaskStop` its in-flight agent, resetting the label so it can be retried.
- **`stop` / `halt`** — drain, `TaskStop` all running agents, and reset their labels.

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

## Reading current state without the cockpit

```bash
gh issue list --repo <repo> --label "plan review"
gh issue list --repo <repo> --label "blocked"
gh pr list --repo <repo> --label "approved"
gh pr list --repo <repo> --label "needs human"
```

These are deliberately **unfiltered** — a global view across all operators, unlike the cockpit's `--assignee "@me"` ticks. Add `--assignee "<login>"` for one operator's slice, or `--search "no:assignee"` to find unowned items.
