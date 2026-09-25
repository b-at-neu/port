# Escalation, liveness, rebase conflicts, and recovery

Read alongside `PIPELINE.md`, not a standalone component — moved byte-identical out of it (#181). What the pipeline does when something goes wrong, and what the human does about it.

## Escalation

- **Review and revise not converging** — before each revise dispatch the cockpit counts `## Code Review` comments; at `reviewCycleCap`, **unconditional** — whatever the latest verdict said — it labels `needs human`, comments, and stops dispatching for that item.
- **A clean review keeps not merging** — before each `readyForReview` dispatch the cockpit compares the newest `## Code Review`'s `commit.oid` against the current `headRefOid`; equal, with no newer `## Gate cleared`, means a review would grade a diff it already graded, so it labels `needs human` and comments instead of opening a redundant cycle. See `## Check evidence` → "Zero-diff review".
- **Implementation blocker** — `impl-agent` comments `## Blocker`, labels `blocked`, and reports `BLOCKED:`; the cockpit relays and resumes the same agent with the human's decision.
- **Rebase conflict during revision** — `revise-agent` resolves everything inferrable and escalates only the genuinely ambiguous hunks as numbered decision requests; it aborts the whole rebase, comments `## Pipeline Escalation`, and labels `needs human` whenever any hunk is ambiguous or on the never-touch list. `unblock #N` relays the options and re-dispatches with the operator's selections.
- **Plan questions** — `plan-agent` never guesses: it returns `QUESTIONS FOR HUMAN:` and the cockpit relays, then resumes it with answers.
- **No verdict formed while checks are pending** — `review-agent` waits, bounded, for every check on the head commit to conclude before posting; a timeout is `blocked — checks pending`, never a pass. See `## Check evidence`.
- **A check goes red after approval** — the cockpit re-verifies every `<labels.approved>` pull request each tick and, under the sole carve-out in `## Check evidence`, routes it back to `<labels.needsRevision>` with `## Approval withdrawn` naming the check.
- **Stalled or usage-limited agent** — an in-flight label with no live `TaskList` entry means the agent crashed or hit a usage limit, not that work is proceeding; see "Liveness" for how the cockpit tells the two apart and responds.
- **A pull request cannot be reviewed against a diff CI never validated** — the cockpit reads `mergeable` at the dispatch gate and at the approved re-verify, and `review-agent` reads it again at its own exit; `CONFLICTING` forms no verdict, dispatches no review, and adds `<labels.refreshBranch>` with `## Rebase required` instead — see "Branch refresh". This is a routine reroute, not a human escalation; the two genuine escalations a refresh can reach are listed next.
- **A refresh isn't converging** — a pull request's head SHA still reads `CONFLICTING` after this session already refreshed it once, or it has been refreshed `3` consecutive times and still conflicts: the cockpit escalates to `<labels.needsHuman>` rather than refreshing it again. See "Branch refresh" and `pipeline/SKILL.md` for the exact bounds.
- **A ticket exceeds its dispatch budget** — *(`commands.budget`)* a per-ticket `budget.wallClockMinutes` ceiling on cumulative agent wall-clock, the shape `reviewCycleCap` already uses; at or over it, `dispatch` returns `exceeded` and the cockpit escalates to `<labels.needsHuman>` instead of dispatching. The ledger lives on the issue as a `## Pipeline Cost` comment the script owns; an unreadable ledger holds dispatch one tick then dispatches anyway on a second consecutive failure, and a row closed without confirming a graceful finish is marked `lost` and counted anyway.

### Liveness

An in-flight label is a claim, not a heartbeat — nothing about it tells the cockpit whether an agent is still running. **`TaskList` is called every tick, unconditionally; a tick that reports on liveness without a `TaskList` call this tick has failed.** The call happens whether or not anything is in flight — an empty in-flight set is exactly the case where a stall is invisible, so it is never a reason to skip the call. **A label is not evidence of liveness or of non-liveness** — an in-flight label never proves an agent is alive (it may have crashed), and a terminal or absent label never proves one is dead (a completion notice can arrive before the label swap lands, or the cockpit's own view of labels can be stale). `TaskList` is the only evidence either direction.

Every tick, the cockpit queries the in-flight labels (`planning`, `in progress`, `reviewing`, `revising`, and `refreshing`) and cross-checks the result against that `TaskList` call, matching entries by the dispatch `description` (`"<stage> #<n>"`). Four termination classes distinguish what a completed or vanished agent means:

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
| An item sits at a trigger label and nothing dispatches | Its marker slot holds `SESSION REQUIRED` (see "Detection") — the cockpit never dispatches those | Open a named session and run `/port:implement <n>` |
| An item sits at `plan approved` and nothing dispatches, and its marker slot holds no `SESSION REQUIRED` marker | It is held behind an in-flight item whose plan claims `concurrency.overlapThreshold` or more of its non-`sharedFiles` paths | The tick's held line names the blocker, the contended paths, and their count; `dispatch #N anyway` overrides |
| No check runs at all on a new push, while the deployment still runs | The pull request conflicts with its base, so GitHub cannot build the merge ref that `pull_request` workflows run against | `gh pr view <n> --json mergeable` reports `CONFLICTING`. The cockpit labels it `refresh branch` automatically next tick, or force it now with `refresh #N` |
| The approval check shows **Skipped** on a pipeline pull request | It is missing the `claude` label, so the gate is inactive | Add the label; the `labeled` event re-evaluates the job condition |
| Untracked directories accumulating beside `.claude/worktrees/` entries (a *registered* worktree for a finished item is reclaimed automatically — see "Worktree lifecycle") | Agents cut off mid-run; on Windows the harness de-registers a worktree but cannot delete a populated dependency tree | Run **`/port:worktree-clean`** from the main checkout — the report names each `orphan-dir` |
| A worktree the cockpit reports `locked`, with no in-flight item behind it | A human or the harness locked it deliberately; the reclaimer never auto-unlocks | The report names the exact `git worktree unlock "<path>"` command, or run `/port:worktree-clean`, which unlocks after confirmation |
| A session prints a different commit than `git rev-parse --short HEAD` in this checkout, or warns that two install records share a commit | An install performed from inside a managed worktree — every install scope shares one `installPath` | Reinstall from the main checkout; see "Why background dispatch needs care" → install policy |
| Cockpit sits idle and never ticks again | A tick ended without calling `ScheduleWakeup` — the closing line was narrated instead of the call being made | Say anything to it to force a tick; the tick's closing line is only trustworthy once it is the record of a real `ScheduleWakeup` call |
| An agent stopped with `BLOCKED:` or hit `maxTurns` | A clean stop by design, not a crash | Resolve the blocker, or widen scope or permissions, then `retry #N` |
| A stage misbehaved and you want to run it by hand | — | Mention the subagent directly, or run a whole session as it |
| Cockpit session closed | All state is in labels | Start `/port:pipeline` again; it resumes from the labels |
| Labels changed manually on GitHub | Fine — labels are the source of truth | The next tick acts on whatever the labels say |
| A permission change was merged but agents still hit denials | A worktree carries the *committed* settings | Confirm it merged to `<integration>`; agents pick it up on their next fresh worktree |
| `/port:pipeline` refuses to start | The checked-out branch carries no `.claude/port.config.json`, or no `permissions.allow` | Check out the branch the harness was installed on, or run `/port:init` on this one |
| A plugin was installed and merged, but agents behave as if it is absent | Merging declares a plugin, it does not install one | Update the main checkout, refresh the machine's plugin install, restart the cockpit |
| An item parked at an in-flight label, this session dispatched it, and no matching `TaskList` entry | The dispatched agent failed or the session closed mid-flight | The liveness cross-check reports it **suspect**, then auto-resets it to its trigger label the tick after — `retry #N` works too, immediately |
| An item parked at an in-flight label with no matching `TaskList` entry, and this session's dispatch log has no row for it | A prior session's (or another cockpit's) work — this session cannot prove it is dead | Reported every tick as "in flight with no dispatch record," never touched automatically; `retry #N` resets it by hand |
| An item was auto-reset once and stalls again in the same session | The once-per-session cap held — a crash loop reports rather than resetting forever | `retry #N` for another attempt; restarting the cockpit clears the cap (fresh dispatch log) |
| Every dispatched agent failed at once, all reporting a session-limit message | The operator's usage window was exhausted | The cockpit parks each affected item back at its trigger label and schedules the next wakeup just after the reported reset time; nothing to retry manually |
| The cockpit says a gate clear was denied | Correct behaviour — the guard hook denies removing `<labels.needsHuman>` unless an operator instruction just named that item | Say `unblock #N` if you actually mean to clear it |
| The cockpit says a branch checkout was denied | Correct behaviour (#216) — the guard hook denies `git checkout`/`git switch` from a session that has invoked the cockpit skill, so its own startup refusal can't be escaped by switching branches | Follow the preflight's hard-stop message: check out a branch that carries the config, or run `/port:init` |
| Nothing answers an item at `plan review` — no `AskUserQuestion`, no label swap, every tick | A `plan-gate` claim (#206) is held by an external surface, or the claim file is unreadable — the cockpit stands down from the whole gate | Release the claim in the app, or delete `.agents/gate-claim.json`, to take the gate back — see `PIPELINE.md` → "External gate claim" |
| A `gh issue edit`/`gh pr edit` adding or removing a plan-gate label (`plan review`, `plan approved`, `plan changes requested`) was denied | Correct behaviour (#206) — the guard hook denies the cockpit's own write while an external `plan-gate` claim holds or cannot be read | Release the claim in the app, or delete `.agents/gate-claim.json`, first |
| A batch label change moved only some of the items | A partial application — the same failure mode a shell loop used to hide | The re-query the cockpit runs after every multi-item change reports exactly which one did not move; re-issue for the remainder |
| A pull request was approved and then moved back to `needs revision` | A check on it went red after approval | The `## Approval withdrawn` comment names the check; revision dispatches this tick |
| An approved pull request gained `refresh branch` and stayed `approved` | `mergeable` reads `CONFLICTING`; a clean rebase doesn't change the diff that was approved | The `## Rebase required` comment names why; `revise-agent` refreshes it and, only if it actually had to resolve a conflict, withdraws the approval itself |
| `review-agent` stopped without a verdict | Checks never concluded within the bounded wait | The pull request is at `<labels.needsHuman>`; `unblock #N` is the route |
| A pull request at `ready for review` never gets reviewed, and the cockpit reports it conflicting | `mergeable` reads `CONFLICTING` — GitHub never ran checks on this diff | The cockpit posts `## Rebase required` and adds `refresh branch`, leaving `ready for review` in place; `revise-agent` rebases, pushes, and it is reviewed automatically once checks conclude |
| A pull request bounced through review cleanly `reviewCycleCap` times without ever merging | The cap is unconditional — it fires whatever the latest verdict said, not only when findings are still open | The pull request is at `<labels.needsHuman>`; `unblock #N` picks a route |
| A pull request at `ready for review` never gets reviewed, and the cockpit says the head was already reviewed | The zero-diff gate — the newest `## Code Review`'s `commit.oid` equals the current `headRefOid`, so a new review would grade the same diff | `unblock #N` → **Back to review** authorizes exactly one more review against this head |
| A tick reports "the tick query failed" and does nothing else | The single collapsed `gh api graphql` call returned no `data` — a **blind tick** | Correct, conservative behaviour, not a bug: nothing was dispatched, no label moved, and a wakeup was still scheduled at the pacing floor. It self-heals next tick if the transient cause clears |
| A tick reports one label's set as "returned N of M items" | A GraphQL connection's `totalCount` exceeded its `nodes` length — that set is **truncated, not complete** | The cockpit already acted only on what it received; nothing to fix unless the true set size needs a larger `first:` in `.temp/tick-query.graphql` |
| The cockpit opens with "Resumed after a gap" | The session was closed or stalled long enough that the elapsed time materially overshoots what was last scheduled | Expected after any real gap — it treats the tick as changed and polls at the floor once, since items may have moved unattended while it was gone |
| The cockpit's closing line shows a delay above 270s while an item still needs a human | The pacing ladder backed off because nothing was going to move without the human anyway | Not a stall — say what you need to say (approve a plan, `unblock #N`, merge) and the next tick resets to the floor the moment it sees the change |
| The cockpit warns it is N commits behind | Expected after any merge to `<integration>` (or the marketplace `ref`) this session — the running copy predates it | Nothing is broken meanwhile; refresh the machine's plugin install and restart the session to load it |
| The cockpit warns two install records share one cache path | An install performed from a second scope (or from inside a worktree) repointed the shared `installPath` | Re-install from the main checkout so the record this session resolves matches what you intended |

## Reading current state without the cockpit

```bash
gh issue list --repo <repo> --label "plan review"
gh issue list --repo <repo> --label "blocked"
gh pr list --repo <repo> --label "approved"
gh pr list --repo <repo> --label "needs human"
```

These are deliberately **unfiltered** — a global view across all operators, unlike the cockpit's `--assignee "@me"` ticks. Add `--assignee "<login>"` for one operator's slice, or `--search "no:assignee"` to find unowned items.
