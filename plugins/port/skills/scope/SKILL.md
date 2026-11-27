---
name: scope
description: Stage 0 — interactive decomposition of a major feature into an epic with dependency-ordered sub-issues, before any per-ticket planning. Runs on the session model; use a strong one. Usage: /port:scope <feature description>
argument-hint: "<feature description>"
allowed-tools: Read Write Grep Glob AskUserQuestion
---

# Scope — Stage 0: epic decomposition

**Trigger:** manual — a human wants to break a major feature into tickets before planning.
**Input:** `$ARGUMENTS`, a feature description which may be rough.
**Model:** inherits the session. Use a strong one; this is the highest-leverage thinking in the pipeline, and every later stage amplifies it.

Small bug fixes and single-scope tickets do **not** need this stage — file an issue and opt it in through `/port:pipeline` directly.

**Requires `modules.scope`.** If `.claude/port.config.json` sets it false, say the repository has no decomposition flow configured and stop.

## Read the configuration first

Read `.claude/port.config.json` for `repo`, `commands.tracker` and `docs.engineering`. If it is missing, stop — this repository is not port-managed.

If `commands.tracker` is null, stop before brainstorming and say: "This repository has no tracker CLI installed, so I can't create tickets. Run `/port:init` and choose **Reconcile** to install it."

## 1. Brainstorm

This is a conversation, not a form. Ask **one question at a time**, multiple choice where possible, until you understand:

- **Purpose** — what user or business problem this solves, and what done looks like
- **Constraints** — data-model implications, roles and permissions affected, existing behaviour it must not break
- **Success criteria** — how a human verifies the feature works
- **Decomposition** — independently shippable sub-tickets, each one pull-request sized, ordered by dependency. Size each against the code it touches: aim for about 800 added or changed lines across about 30 files whose logic changes, with a cap of 1,000 lines or 40 files. Moves, import-only fixes, deletions and generated files don't count. Combine slices under about 300 lines with a neighbour, since every ticket also pays for its own plan and review.

Read `docs.engineering` when it is set, plus the relevant parts of the codebase, so the decomposition reflects how this repository is actually built rather than a generic shape.

## 2. Present the breakdown — get approval before creating anything

Show the epic summary, the sub-tickets with a two-to-three sentence scope each, and the dependency order. Iterate until the human approves. **Create no issues before approval.**

## 3. Create the issues

Tickets go to the repository's configured tracker, through `<commands.tracker>` only. Never call a vendor's CLI or API directly.

Write each body with the Write tool rather than passing it inline — bodies contain markdown and backticks, and inline quoting fails cross-platform. Each sub-ticket body ends with a `## Size` section giving its estimated files and lines, so the plan stage can check it.

Create the parent epic, then each sub-ticket, keeping the key each call prints:

```bash
<commands.tracker> create --title "<Epic Title>" --body-file .temp/epic.md
<commands.tracker> create --title "<Sub-Ticket Title>" --body-file .temp/sub-<k>.md
```

Link each child to the epic:

```bash
<commands.tracker> link-child --parent <epic-key> --child <key>
```

Where order matters, add a blocked-by relation for every dependency, covering every transitive dependency rather than just one:

```bash
<commands.tracker> block --blocked <key> --by <key>
```

On any `FAIL` line, stop. Report the keys already created and the links already made, and never re-run `create` for a ticket that already printed a key.

**Leave every ticket unassigned and unlabelled.** Opt-in is what claims a ticket, and it assigns as well as labels. Until then the cockpit's unowned sweep is what keeps these visible — which is why they must carry no trigger label either.

## 4. Hand back

List the created ticket keys — epic and sub-tickets, in dependency order. Then remind the human:

> Nothing is opted in yet — in `/port:pipeline`, say "work on #N" to start a sub-ticket. The cockpit will warn if its blockers aren't merged.
