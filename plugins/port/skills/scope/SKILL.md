---
name: scope
description: Stage 0 — interactive decomposition of a major feature into an epic with dependency-ordered sub-issues, before any per-ticket planning. Runs on the session model; use a strong one. Usage: /port:scope <feature description>
allowed-tools: Bash(gh issue create *) Bash(gh issue view *) Bash(gh issue edit *) Bash(gh api repos/*) Bash(gh api graphql *) Read Grep Glob AskUserQuestion
---

# Scope — Stage 0: epic decomposition

**Trigger:** manual — a human wants to break a major feature into tickets before planning.
**Input:** `$ARGUMENTS`, a feature description which may be rough.
**Model:** inherits the session. Use a strong one; this is the highest-leverage thinking in the pipeline, and every later stage amplifies it.

Small bug fixes and single-scope tickets do **not** need this stage — file an issue and opt it in through `/port:pipeline` directly.

**Requires `modules.scope`.** If `.claude/port.config.json` sets it false, say the repository has no decomposition flow configured and stop.

## Read the configuration first

Read `.claude/port.config.json` for `repo` (written `<repo>` below, and `<owner>`/`<name>` where a call needs them split) and `docs.engineering`. If it is missing, stop — this repository is not port-managed. If instead one exists at the repository root, say so and name the fix — move it under `.claude/`, or re-run `/port:init` — rather than reporting a repository that plainly is managed as unmanaged.

## 1. Brainstorm

This is a conversation, not a form. Ask **one question at a time**, multiple choice where possible, until you understand:

- **Purpose** — what user or business problem this solves, and what done looks like
- **Constraints** — data-model implications, roles and permissions affected, existing behaviour it must not break
- **Success criteria** — how a human verifies the feature works
- **Decomposition** — independently shippable sub-tickets, each one pull-request sized, ordered by dependency

Read `docs.engineering` when it is set, plus the relevant parts of the codebase, so the decomposition reflects how this repository is actually built rather than a generic shape.

## 2. Present the breakdown — get approval before creating anything

Show the epic summary, the sub-tickets with a two-to-three sentence scope each, and the dependency order. Iterate until the human approves. **Create no issues before approval.**

## 3. Create the issues

Create the parent epic, then each sub-issue:

```bash
gh issue create --repo <repo> --title "<Epic Title>" --body-file .temp/epic.md
gh issue create --repo <repo> --title "<Sub-Ticket Title>" --body-file .temp/sub-<k>.md
```

Write each body with the Write tool rather than passing it inline — bodies contain markdown and backticks, and inline quoting fails cross-platform.

Link each child to the epic. This uses the REST API and the **database `id`**, not the issue number:

```bash
gh api repos/<repo>/issues/<child-number> --jq '.id'
gh api repos/<repo>/issues/<epic-number>/sub_issues -X POST -F sub_issue_id=<database-id>
```

Where order matters, add blocked-by relationships. This uses GraphQL and **node IDs**, a third kind of identifier — do not mix the three up:

```bash
gh api repos/<repo>/issues/<number> --jq '.node_id'
# issueId = the blocked issue; blockingIssueId = the blocker
gh api graphql -f query='mutation { addBlockedBy(input: { issueId: "BLOCKED_NODE_ID", blockingIssueId: "BLOCKER_NODE_ID" }) { clientMutationId } }'
```

**Leave every ticket unassigned and unlabelled.** Opt-in is what claims a ticket, and it assigns as well as labels. Until then the cockpit's unowned sweep is what keeps these visible — which is why they must carry no trigger label either.

## 4. Hand back

List the created issue numbers — epic and sub-tickets, in dependency order. Then remind the human:

> Nothing is opted in yet — in `/port:pipeline`, say "work on #N" to start a sub-ticket. The cockpit will warn if its blockers aren't merged.
