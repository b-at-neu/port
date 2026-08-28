---
name: implement
description: Run pipeline stage 2 or 4 yourself, in your own session, for a ticket marked SESSION REQUIRED — one that cannot be handed to a dispatched agent because it touches a path the harness blocks subagents from editing. Resolves the stage from the item's labels, works in a dedicated worktree, and follows the existing impl-agent and revise-agent definitions unchanged. Manual only. Usage: /port:implement <issue-or-pr-number>
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion
---

# Implement — operator-run pipeline stage

**Trigger:** manual, in an operator's own session. **Input:** an issue or pull request number (`<n>`).

The harness denies `Edit` and `Write` under `.claude/` to **dispatched subagents**, and project settings cannot grant it back — so `impl-agent` and `revise-agent` cannot run for tickets touching those paths. Your session has no such restriction. Those tickets are marked **`SESSION REQUIRED`** in their body, and the cockpit announces them instead of dispatching.

This skill is a **thin wrapper**: it points you at the existing agent definition and overrides only the rules that exist *because* that agent is a subagent. Background: `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Session-required tickets".

**The agent files are the workflow. Do not modify them, and do not reimplement them here.**

## Read the configuration first

Read `.claude/port.config.json` for `repo` (`<repo>`), `branches.integration` (`<integration>`), the label names (`<labels.X>`), `commands.bootstrap`, `commands.checks`, `docs.engineering`, and `modules.approvalGate`. If it is missing, stop — this repository is not port-managed.

## 1. Name this session (first output line)

Derive `#<issue>: <2–5 lowercase words>` from the issue title and print it as your first line:

> Name this session: `#503: operator config route`

If a session-title tool is in scope, set the title directly. Otherwise tell the operator to run `/rename <that string>` — **never to relaunch the session.** Throwing away a session mid-task over its title is not a reasonable ask when a rename does the same job.

You cannot emit a slash command yourself, so where no tool exists this is an instruction to the human: **state it and move on; never block on it.** In revise mode the name still carries the **issue** number, not the pull request number.

## 2. Record the main checkout

```bash
git rev-parse --show-toplevel
```

Keep that path. **Every instruction file is read by absolute path from the installed plugin or that main checkout** — the agent definitions under `${CLAUDE_PLUGIN_ROOT}/agents/`, `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md`, and the repository's own `docs.engineering` and `CLAUDE.md` — while **every edit goes only to paths inside the worktree.** That split is what makes a ticket that edits an agent file safe: you follow the committed version while changing the worktree copy.

## 3. Resolve the mode from state

```bash
gh pr view <n> --repo <repo> --json labels,headRefName,baseRefName,title,body
```

- Resolves to a pull request at `<labels.needsRevision>` → **revise mode** (`${CLAUDE_PLUGIN_ROOT}/agents/revise-agent.md`).
- Otherwise:

  ```bash
  gh issue view <n> --repo <repo> --json labels,assignees,title,body
  ```

  At `<labels.planApproved>` → **impl mode** (`${CLAUDE_PLUGIN_ROOT}/agents/impl-agent.md`). **Record the issue's assignee login** (`@me` if none) — the pull request must carry it.

- Anything else → stop, report the current labels, change nothing: `#<n> is not awaiting an operator (labels: …). Nothing was changed.`

**If the item carries the trigger label but its body has no `SESSION REQUIRED` marker,** ask first (AskUserQuestion): *"#412 isn't marked `SESSION REQUIRED`, so the cockpit will dispatch an agent for it too. Proceed anyway / Cancel."* A double dispatch — cockpit and operator on the same item — is the hazard this guards.

Then report the resolved mode, worktree path, and branch **before** the slow steps, so the operator can see you picked the right stage.

## 4. Create the worktree

Never work in the main checkout: editing configuration from the session using it mutates your live setup mid-task. Never touch another worktree, and never `--force`.

**impl mode** — branch straight off the integration branch; this replaces the agent's checkout-then-rebase:

```bash
git fetch origin
git worktree add -b <n>-ticket-name-in-kebab-case .claude/worktrees/impl-<n> origin/<integration>
```

**revise mode** — detached at the pull request's head, rebased onto its own base:

```bash
git fetch origin
git worktree add --detach .claude/worktrees/impl-<n> origin/<headRefName>
```

Then work inside the worktree and run each entry in `commands.bootstrap` in order. In revise mode, rebase onto the base branch from inside the worktree: `git rebase origin/<baseRefName>` — the pull request's **own** base, not an assumed one.

## 5. Follow the agent file

Read the resolved agent file and follow it end to end: label swaps, the plan checklist, the file-based commit format, `commands.checks`, push by refspec, the pull request body format, base `<integration>`, the issue's assignee, thread resolution, the revision note. Read `docs.engineering` too when it is set, as the agent file requires.

**Carry the marker into the pull request (impl mode).** The cockpit re-reads it there to decide stage 4, so the description must repeat it verbatim, directly under `Closes #N`:

```
Closes #503

> **SESSION REQUIRED:** touches `.claude/**` — a dispatched agent can't edit those
```

Same literal string as the issue plan. **The routing marker is never a label.**

*(`modules.approvalGate`)* The one label `gh pr create` passes is `<labels.marker>`, exactly as the agent file specifies — it **activates the approval gate**, so a pull request opened without it merges with no gate at all. When the module is off, omit it, as the agent file does.

## 6. Overrides

**This is the whole list. Anything not here applies unchanged** — if an agent file gains a rule that only makes sense for a subagent, it belongs here.

1. **`permissionMode: dontAsk` and "auto-denied silently"** — not your mode. Your session prompts normally.
2. **"Stop and emit `BLOCKED:`"** — pointless with a human present. Ask the operator directly and wait. Never emit a `BLOCKED:` sentinel, never guess.
3. **"Never spawn subagents"** — not applicable.
4. **The shell-discipline block** (`${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Operating rules (all stage agents)") — one command per call, no `cd`/`ENV=val` prefix, quoted cwd-relative paths — exists for the subagent's allowlist. Use whatever is clearest. **Still preferred:** the repository's declared `commands` over ad-hoc equivalents, and `git rm` for tracked deletions.
5. **"You are already in a worktree; never run `git worktree`"** — inverted. You create the worktree in step 4 and work inside it.
6. **Instruction files are read from the installed plugin and the recorded main checkout**, not the cwd — the worktree copy may be the very thing you are editing.
7. **Operator-only `## Testing` steps are yours to run** — that is precisely what your session can do and a dispatched agent cannot. Run them, and record the outcome in the pull request's testing plan rather than leaving the box unticked.

## 7. Handoff

Per the agent file's own handoff step:

- **impl** — issue `<labels.inProgress>` → `<labels.prOpened>`; pull request gets `<labels.readyForReview>`.
- **revise** — pull request `<labels.revising>` → `<labels.readyForReview>`.

The cockpit picks up review on its next tick. Finish by telling the operator the pull request URL, the labels applied, and that `/port:worktree-clean` reclaims `.claude/worktrees/impl-<n>` once it merges.
