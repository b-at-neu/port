# Coordination between the cockpit and the desktop app

`/port:pipeline` and `apps/desktop` can both look at the same repository. This document is the decision on who writes what when both are present, so the write path in #92 and the reconciler in #79 build against a settled contract rather than guessing at one. **It changes no behaviour and adds no write path** — the enforcement lands in a follow-up (see below).

## The decision

**Split ownership by what authorises the write, not by repository.** The cockpit keeps every write a *machine observation* authorises — liveness resets, escalations, approval withdrawal, refresh — because it is the only thing that observes them. A *human decision* write is transferred, scope by scope, through a durable claim file that an external gate owner writes and only a human releases. Exactly one scope needs the transfer today: `plan-gate`. It is the only divergent decision in this epic, and the only one the cockpit takes unprompted — `auto plan` swaps `plan review` → `plan approved` with no interaction, so there is no race window to narrow there; the cockpit simply always wins it.

## Why not the other three

- **Assignee partitioning — rejected.** `@me` resolves to the same `gh auth` account for both writers, so a distinct identity would mean a second GitHub account. Worse, `impl-agent` copies the issue's assignee onto the pull request it opens, so a UI-owned item would produce pull requests no cockpit ever sees. It also partitions the wrong axis: both writers must keep *seeing* every item; they must only not both *decide*.
- **Config flag — rejected as the mechanism, adopted as the shape.** `.claude/port.config.json` is committed and repository-wide, so one operator flipping it stands down every other operator's cockpit, including operators with no UI at all. The claim file is that same switch, scoped to where the choice actually lives — one checkout, one operator.
- **UI-only writes — rejected now, correct later.** Most of the cockpit's writes are machine observations it alone can make, and the UI cannot make any of them until #105 lands a tick engine and #106 lands dispatch. Stripping them today would delete the pipeline's self-healing across this epic and #96's, for a boundary that is cleaner only on paper. It is the destination: #111 is where the cockpit is retired and this option arrives by construction.
- **Per-repo lease — adopted, reshaped.** Per-checkout rather than per-repo, and a durable claim rather than a lease, for the reasons under "The claim contract" below.

## Who owns which write

Every write the cockpit makes today, classified:

| Write | Authorised by | Owner |
| --- | --- | --- |
| `planReview` → `planApproved` / `planChangesRequested`, including the `autoPlan` swap | a human answering the gate | **external gate owner**, under a `plan-gate` claim |
| opt-in (`work on #N`): add marker, `ready`, optional `autoPlan`, assignee | human | either — convergent |
| `pause`, `resume`, `retry`, `gate #N`, `refresh #N` | human | either — convergent |
| removing `needsHuman` (`unblock #N`) | human, guarded | cockpit only — see "Risks" below |
| liveness reset, usage-limit park | machine observation | cockpit only |
| cycle-cap and zero-diff escalation to `needsHuman` | machine observation | cockpit only |
| approval withdrawal on a red check | machine observation | cockpit only |
| refresh sweep adding `refreshBranch` | machine observation | cockpit only |
| dispatch | machine | cockpit only, for the whole of this epic |

**"Either — convergent" is safe without exclusion.** Both writers reach the same label state, and the cockpit re-derives everything from live labels each tick, so a duplicate write is a no-op. The one residual is the pause/dispatch race, and it is not silenced — it is presented (`dispatch-overtook-pause`, below).

Answering the ticket's three problem bullets against this table:

- **A duplicated dispatch.** The UI does not dispatch anywhere in this epic, so an approval in the UI makes the cockpit's next tick dispatch exactly once. Dispatch becomes two-writer only at #105/#106 — that is deferred, not solved, by this decision.
- **A stale announced set.** Already closed by the tick collapse: the announced set is `.temp/tick-state.md`'s `Announced approved`, re-verified every tick against a live per-number `pullRequest(number:)` alias and dropped once the state is no longer `OPEN` (`SKILL.md` → "Merged-pull-request reconciliation"). Neither writer may merge, so no coordination is needed here.
- **A same-window double write.** Never write from a list read; re-read the single item authoritatively immediately before writing. GitHub has no compare-and-set on labels, so this narrows the window to one round trip and does not close it — the claim below is what prevents the collision, and read-verify-write is what makes the losing writer abort instead of clobbering.

## The claim contract

**The claim file.** `<base repository root>/.agents/gate-claim.json` — beside the guard hook's own `denials.log`, resolved through `git rev-parse --git-common-dir` so every worktree of a checkout sees the one claim rather than a per-worktree copy. `.agents/` is already gitignored, so the claim is per-checkout and per-operator, which is the axis ownership actually varies on.

```json
{
  "repo": "b-at-neu/port",
  "owner": "port-desktop",
  "scopes": ["plan-gate"],
  "claimedAt": "2026-09-05T14:02:11Z"
}
```

| Field | Meaning | Rule |
| --- | --- | --- |
| `repo` | the `<repo>` slug this claim is about | a value that is not this repository's `repo` reads as **absent** — a positive determination, not ambiguity, the same rule `.temp/tick-state.md`'s `Repo` header already follows |
| `owner` | free text, for the cockpit's report only | **never** a pid, port, or heartbeat: nothing in this file may be read as liveness (`docs/ENGINEERING.md` §4) |
| `scopes` | the claimed scopes | one recognized value today, `plan-gate`; an unrecognized entry is reported, never silently ignored |
| `claimedAt` | ISO 8601 | reported so the operator sees how long the claim has stood; **never** compared against a clock to expire it |

**`plan-gate` denies the cockpit** adding or removing the resolved names for `planReview`, `planApproved`, and `planChangesRequested`. `autoPlan` is deliberately outside the set — the cockpit's opt-in path still sets it, and its auto-plan *swap* is already denied by `planApproved` being in the set.

**Lifecycle.** A claim is created only by an explicit operator action in the app and released only by an explicit operator action or by deleting the file. **The cockpit never writes or deletes it** — the guard hook denies a write to that path from any caller it can see, exactly because a machine that can release its own constraint is the #138 failure again. Known gap, stated rather than tolerated: the hook only sees `Edit`/`Write`/`NotebookEdit` and the Bash allowlist, so a shell deletion through some future allowlisted binary is not covered.

**Feasibility.** `plugins/port/hooks/lib/guard-rules.mjs`'s `gateClearAttempt` already tokenizes `gh issue edit` / `gh pr edit` quote-aware and reads `--remove-label` values against a configured label name, and `decide` already applies cockpit-class rules to a non-subagent caller; `agent-guard.mjs` already resolves `configRoot` and a base-repository root (`git rev-parse --git-common-dir`) for `.agents/`. The claim rule is a fourth rule of the same shape, extended to `--add-label`, matching a set rather than one name. That rule, and the cockpit's own stand-down, are the follow-up's job — not this ticket's.

## Detecting and presenting a conflict

The copy below is decided here, for #92 and #79 to implement verbatim.

**The reconciler's conflict state.** One state on the item, discriminated by reason — mirroring `RepoProblem`/`RepoDiagnostic` in `apps/desktop/src/shared/repos.ts`, not a new parallel mechanism. It is not folded into `stalled`: a stall is nothing happening, a conflict is two things happening.

```ts
type Conflict =
  | { kind: 'precondition-failed'; expected: string[]; observed: string[]; readAt: string }
  | { kind: 'unattributed-transition'; from: string[]; to: string[]; observedAt: string; lastLocalWriteAt: string | null }
  | { kind: 'dispatch-overtook-pause'; agent: string; pausedAt: string; dispatchedAt: string }
```

Three rules govern every one of them: **abort, never resolve** · **show both readings and when each was taken** · **attribute only what is provable.**

- **`precondition-failed`** (the write aborted):

  > **#148 moved while you were deciding.** You approved a plan for an issue at `plan review`; GitHub has it at `plan approved`, read 2s ago. Nothing was written.
  > **[Show me the current state]** · **[Dismiss]**

- **`unattributed-transition`** (the poll saw a change this app did not make). The honest limit is stated in the copy itself, because GitHub's timeline attributes both writers to the same account:

  > **#148 changed outside this app.** `plan review` → `plan approved`, seen at 14:07. This app's last write to #148 was 13:52. That it was not written here is all this can prove — GitHub records both writers as `@b-at-neu`.

- **`dispatch-overtook-pause`** (the one residual race in the convergent set):

  > **#52 is paused, but an agent is already running on it.** The pause landed at 14:07:12; `impl #52` was dispatched at 14:07:04. Pausing removes a label — it does not stop a running agent. Stop it from the cockpit: `stop #52`.

- **No claim held** (a standing state, not a race — the gate controls are disabled, and the reason is on screen rather than in a tooltip):

  > **The plan gate isn't claimed here.** The cockpit is still answering it in your terminal. **[Take the plan gate]**

- **Claim unreadable** (the loud stall the fail direction below chooses):

  > **`.agents/gate-claim.json` can't be read.** Until it is valid or removed, this app and the cockpit both stand down from the plan gate — nothing will answer #148. Fix or delete the file.

**The cockpit's stand-down report** (the follow-up implements it; the copy is decided here, so it is one line per tick and never a silent omission):

> 🖥️ **Plan gate claimed by `port-desktop`** since 2026-09-05T14:02Z. 2 issues wait at `plan review`: #148, #151 — I won't approve or bounce them. Release the claim in the app, or delete `.agents/gate-claim.json`, to take the gate back.

## Failure directions

Every direction below is chosen deliberately; neither side of any of them is a default (`docs/ENGINEERING.md` §4).

- **The claim fails toward "nobody writes the claimed scope", never toward "ownership reverts."** This is why option 1 is adopted as a *claim* and not as a lease: an expiry produces a silent ownership transfer, and the cockpit then answers a gate the operator was about to answer — a wrong decision. A claim with no expiry produces a visible stall instead, which the cockpit reports every tick and one operator action clears.
- **A malformed claim reads as claimed**, on both sides, with the reason named. The ambiguous case is which writer owns the gate; standing both down is the only reading that cannot produce an unintended decision.
- **The hook's own read throwing stays fail-open** (`hook-error`, unchanged) — an internally broken hook must never block unrelated work. Unintelligible *data* and a failed read are different events, and are treated differently.
- **Conflict detection fails toward reporting, never toward resolving.** No write is retried, and no "overwrite anyway" control exists.

## Risks / notes

**Why a prose rail is not enough, and the hook is.** Both cockpit-class guard rules exist because the cockpit violated a prose rail under throughput pressure — the shell loop (#120) and clearing its own `needsHuman` gate thirteen minutes after setting it (#138). `docs/ENGINEERING.md` §7 turns that into a rule: a rail is a checkable precondition, never "never do X". The claim is therefore enforced twice — the cockpit reads it and skips the gate, and the hook denies it if the model does not. Only the second half is load-bearing.

**`unblock #N` cannot move to the UI at all yet, and that bounds the epic.** The guard hook's gate rule authorises the removal from the *calling Claude session's own transcript* (`recentOperatorMessages`). The app has no transcript, so it structurally cannot clear `needsHuman` until it hosts a session itself (#99). Out of this epic's scope either way, but it should be known rather than discovered in #94.

**One scope, not a framework.** `scopes` is an array with exactly one legal member today. That is the natural shape for the question and avoids a format migration when #93 or #94 wants one, but no scope is defined that no ticket implements (`docs/ENGINEERING.md` §7's rule against scaffolding).

## Follow-up

The enforcement — the cockpit standing down, and the guard hook denying it when it does not — is a separate issue, filed as a sub-issue of #88 and blocked by this one. It blocks #92 only; #90, #93, #94, and #95 write nothing divergent and are not gated on it.
