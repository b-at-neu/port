# Using the pipeline

Install and adoption are in the [README](../README.md) — both are per-repository, and nothing is installed globally. This is the operator’s walkthrough for running it.

Reference material — the full label lifecycle, permission model, output formats, and recovery runbook — lives in [plugins/port/docs/PIPELINE.md](../plugins/port/docs/PIPELINE.md). This document points at it rather than repeating it.

## The shape of it

You talk to a cockpit. It talks to GitHub. Agents do the work.

```
/port:pipeline
```

Run this in its own session, on **haiku** if you can — recommended, not required — and in **`default` permission mode**, which matters more:

- **haiku is the recommendation**, because a tick is mechanical — one collapsed query, swap some labels, dispatch, relay. Spending a strong model on it is waste, and a stronger model is also more willing to improvise past the rails below, which is not a trade this stage needs to make. But a skill cannot set the session's model — by the time it runs, the session already is what it is — so this is genuinely your call; the startup report names whichever model you're actually running, as information, with no warning either way.
- **`default` mode**, because a stage agent's disallowed commands are denied by a `PreToolUse` guard hook regardless of this session's mode — but `default` keeps your own edits in this session from auto-accepting, so anything unexpected stays visible. Get this wrong and the pipeline still works, but you lose visibility into your own actions here. The startup report warns if `.claude/settings.json` sets anything else.

Leave the session open. It schedules its own wakeups and reports as things move — see "Pacing" below for how fast.

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

`status` re-runs its query live rather than reading from memory, so it is trustworthy after a long session.

## Pacing

While anything can move on its own — an agent running, an item about to dispatch — the cockpit polls every ~4.5 minutes and never backs off. Once everything left is waiting on a human (a plan to approve, an `approved` pull request to merge, a `needs human` gate), it backs off a step each tick with nothing new to report: ~4.5, ~9, ~18, then ~30 minutes, and holds there.

**This means a label change you make by hand while the cockpit is fully idle can take up to 30 minutes to be noticed**, not 4.5. That is a deliberate trade — a resting cockpit polling every 4.5 minutes forever burns API calls to catch an event that is, by definition, waiting on you anyway — and the cockpit never goes quiet altogether: it keeps scheduling wakeups indefinitely, because it is the only thing that would ever notice a fresh `ready` label. The moment anything changes — a completion, a merge, a new trigger label — it resets to the fast cadence immediately. Say anything to it, or apply the label that unblocks it, and the next tick picks it up without waiting for the backoff to expire.

## When something needs you

Four things come back to you, and only these:

- **The plan gate** — approve, revise, or discuss.
- **A blocker.** Implementation hit something the plan did not cover. The cockpit relays the question and sends your answer back to the same agent, which picks up where it stopped.
- **A question during planning.** Same relay, earlier stage. The planner is instructed never to guess.
- **`needs human`.** Review and revision failed to converge within the cycle cap (unconditional — it fires however clean the latest review was), a rebase hit a conflict too ambiguous to resolve safely, or a review would grade a diff it already graded (a clean bounce that never moved the head). The pipeline stops and waits.

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

Agents leave worktrees under `.claude/worktrees/`. When `commands.worktrees` is configured (`/port:init` offers to install it, given Node), the cockpit reclaims one automatically **the same tick** its issue or pull request merges or closes, plus a startup sweep and a general per-tick pass for anything left over — no confirmation needed, because it only ever removes a worktree that is provably done or holds nothing not already on the integration branch.

What it deliberately never force-removes on its own: a **locked** worktree, a **dirty** one (uncommitted changes), or an **unresolved** one (no correlation to a real issue or pull request, and not provably safe either). It reports each with a reason and, for a locked one, the exact unlock command. When these accumulate, or to force-delete an untracked directory git isn't tracking at all:

```
/port:worktree-clean
```

This skill drives the same reclamation script interactively — review the classified table, then unlock, force-clear dirty candidates, and force-delete orphan directories, each with its own confirmation. On Windows especially, a populated dependency tree can defeat even a forced remove; this skill is what recovers those.

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
