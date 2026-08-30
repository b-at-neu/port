# Using the pipeline

Install and adoption are in the [README](../README.md) — both are per-repository, and nothing is installed globally. This is the operator’s walkthrough for running it.

Reference material — the full label lifecycle, permission model, output formats, and recovery runbook — lives in [plugins/port/docs/PIPELINE.md](../plugins/port/docs/PIPELINE.md). This document points at it rather than repeating it.

## The shape of it

You talk to a cockpit. It talks to GitHub. Agents do the work.

```
/port:pipeline
```

Run this in its own session, on **haiku**, in **`default` permission mode**. Both matter:

- **haiku**, because a tick is mechanical — run some queries, swap some labels, dispatch, relay. Spending a strong model on it is waste.
- **`default` mode**, because a stage agent's disallowed commands are denied by a `PreToolUse` guard hook regardless of this session's mode — but `default` keeps your own edits in this session from auto-accepting, so anything unexpected stays visible. Get this wrong and the pipeline still works, but you lose visibility into your own actions here.

Leave the session open. It schedules its own wakeups and reports as things move.

## Getting a ticket built

```
work on #142
```

It warns you if the ticket has unmerged blockers, asks whether you want to review the plan or auto-approve it, then assigns the ticket to you and starts planning.

**Review the plan for anything with a design dimension.** Auto-approve is for small fixes. The plan gate is the cheapest point to change your mind — after it, an agent writes code against whatever the plan says.

When the plan is ready the cockpit summarizes it and asks: approve, request changes, or discuss. Requesting changes sends your feedback back for revision, so you can iterate without leaving the conversation.

From approval onward it runs on its own: implementation in an isolated worktree, then review, then revision, looping until the findings are at or under the bar for that cycle. What blocks rises as cycles go on, so the first pass polishes everything and later passes only stop for real problems.

Then the pull request is labeled `approved` and the cockpit tells you which checks it's asserting are green — a pending check is announced as not merge-ready yet, never glossed over. **You merge on GitHub.** The pipeline never merges — that gate is absolute.

If a check on an approved pull request goes red afterward — the base moved, or the check re-ran — the cockpit routes it back to `needs revision` on its own, comments naming the check, and revision dispatches automatically. That's the one case the pipeline touches an approved pull request without you asking; everything else about one is left alone until you merge it.

## Talking to the cockpit

Intent, not syntax. These all work:

| Say | Effect |
| --- | --- |
| `work on #142` | Opt a ticket in, claim it, start planning |
| `status` | Live state — everything in flight, everything waiting on you |
| `pause #142` | Drop its trigger label; nothing more happens to it |
| `retry #142` | Re-apply the right trigger for wherever it stalled |
| `unblock #142` | Clear a `needs human` gate deliberately; nothing else can |
| `drain` | Finish what is in flight, start nothing new |
| `resume` | Start ticking again |
| `stop #142` | Halt one item and reset it so it can be retried |
| `halt` | Drain, stop every running agent, reset their labels |

`status` re-runs its queries live rather than reading from memory, so it is trustworthy after a long session.

## When something needs you

Four things come back to you, and only these:

- **The plan gate** — approve, revise, or discuss.
- **A blocker.** Implementation hit something the plan did not cover. The cockpit relays the question and sends your answer back to the same agent, which picks up where it stopped.
- **A question during planning.** Same relay, earlier stage. The planner is instructed never to guess.
- **`needs human`.** Either review and revision failed to converge within the cycle cap, or a rebase hit a conflict too ambiguous to resolve safely. The pipeline stops and waits.

Anything else is reported, not asked.

## Tickets an agent cannot be given

Some tickets touch paths the harness will not let a subagent edit — `.claude/**` and `CLAUDE.md` by default, configurable via `sessionRequiredPaths`. Their plan carries a `SESSION REQUIRED` marker, and the cockpit **announces instead of dispatching**. When only a *verification* step needs such a path, the ticket still dispatches, and the plan marks that one step operator-only for you to run before merge.

Nothing moves until you run it yourself, in a **separate** session:

```bash
claude -n "#503: short name"
# then, in that session:
/port:implement 503
```

The cockpit hands you that command with the name filled in. It has to be a separate session because the cockpit needs to keep ticking, and a long implementation in it would stall everything else.

Review still runs normally afterwards — a session-required ticket is not outside the pipeline, only its implementation step is.

## Starting from a feature rather than a ticket

```
/port:scope <description>
```

A conversation, not a form. It asks questions until it understands the feature, proposes a breakdown into pull-request-sized sub-tickets in dependency order, and creates them only once you approve.

It deliberately leaves them **unassigned** — `work on #N` is what claims a ticket. Until then they sit in the backlog, and the cockpit's unowned sweep keeps them visible.

Run this on a strong model. It is the highest-leverage thinking in the pipeline, and every later stage amplifies whatever it decides.

## Standards

`/port:analyze` reads the codebase and proposes an `ENGINEERING.md`: conventions it found, inconsistencies for you to settle, improvements to approve or drop. It shows you the whole rule set before writing anything.

This matters more than it looks. `docs.engineering` is what implementation builds toward and what review cites — a repository without it gets a pipeline working from the plan and the surrounding code alone.

It also **files findings as tickets rather than fixing them**, which is the point: a ticket gets a plan, a review, and a pull request. The analysis identifies work; the pipeline does it.

Re-run it as the codebase evolves. It diffs against the existing document rather than regenerating, so decisions you already made survive.

## Housekeeping

Agents leave worktrees under `.claude/worktrees/`. The cockpit removes what it safely can each tick and reports what it cannot. When they accumulate:

```
/port:worktree-clean
```

On Windows especially, a populated dependency tree defeats git's own `worktree remove` and `prune`, and orphaned directories build up that neither command can clear. This skill force-deletes them, interactively, from the main checkout.

## Releasing

```
/port:release
```

Works out the next version from what has merged since the last release, recommends a bump with its reasoning, opens the release pull request with a ticket-led changelog, then watches until you merge it — that merge is what ships the release — and drafts the GitHub release and tag as changelog and provenance, after showing you the notes for approval.

Run it once. It schedules its own re-checks, so if a session ends, invoking it again resumes from wherever things stand.

## When it stalls

`status` first — it will usually show the item sitting at a label with nothing dispatching for it.

The common causes, in rough order of likelihood:

- **No trigger label.** Paused, mid-flight, or waiting at a gate. `retry #N` re-applies the right one.
- **Not listed at all.** It is unassigned, or belongs to another operator — every query is filtered to your assignee. The unowned sweep reports these; `work on #N` claims one.
- **Marked `SESSION REQUIRED`.** Nothing will ever dispatch for it. Run `/port:implement`.
- **An agent stopped with `BLOCKED:`.** A clean stop by design. Resolve it and retry.

The full symptom-to-fix table is in [PIPELINE.md's recovery runbook](../plugins/port/docs/PIPELINE.md#recovery-runbook).

Because all durable state is in labels, changing a label on GitHub is always a valid way to intervene. The next tick acts on whatever the labels say.
