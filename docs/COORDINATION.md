# Coordination between the cockpit and the desktop app

`/port:pipeline` and `apps/desktop` can both look at the same repository, but only one of them may ever run its pipeline there at a time (#331). This document is the decision on how that exclusivity is held and released, so every writer in the app and every rule in the guard hook build against one settled contract.

## The decision

**One ownership record decides who runs a checkout, full stop.** Every write either cockpit makes — a human decision or a machine observation alike — is made only by whichever side the record names, `app` or `terminal`; the other side makes no GitHub write at all while that holds. There is no more per-scope split and no more "either — convergent" category: the write chokepoint (`main/writes/apply.ts`'s `applyLabels`/`postComment`) reads the one record before every write, uniformly, and refuses outright when a terminal cockpit holds it. An **absent** record — nobody has run this checkout yet — refuses nothing: either side may act, the same as before any claim existed.

This replaces the two gate-claim scopes (`plan-gate`, `dispatch`) #92/#265/#292 built up over time. Splitting authority by *what kind of write* turned out to be more machinery than the actual question needed: the operator never wants the app and a terminal cockpit answering the same repository's gates and dispatching its stage agents at once, for any reason. One record, one verdict, answers that directly.

## The ownership record

**The record.** `<base repository root>/.agents/cockpit.json` — beside the guard hook's own `denials.log`, resolved through `git rev-parse --git-common-dir` so every worktree of a checkout sees the one record rather than a per-worktree copy. `.agents/` is already gitignored, so the record is per-checkout, the axis ownership actually varies on.

```json
{
  "repo": "b-at-neu/port",
  "owner": "app",
  "since": "2026-10-06T14:02:11Z"
}
```

| Field | Meaning | Rule |
| --- | --- | --- |
| `repo` | the `<repo>` slug this record is about | a value that is not this repository's `repo` reads as **absent** — a positive determination, not ambiguity, the same rule `.temp/tick-state.md`'s `Repo` header already follows |
| `owner` | `"app"` or `"terminal"` | **never** a pid, port, or heartbeat: nothing in this file may be read as liveness (`docs/ENGINEERING.md` §4) |
| `since` | ISO 8601 | reported so the operator sees how long the record has stood; **never** compared against a clock to expire it |

**The verdict table**, read fresh every tick, never cached:

| Verdict | When | The app | The terminal cockpit |
| --- | --- | --- | --- |
| `absent` | no file, or `repo` names another repository | may take ownership on Run/Drain | takes it at its own preflight |
| `app` | parses, `repo` matches, `owner: "app"`, `since` is a string | runs the repo; every write proceeds | refuses at preflight, stops at its next tick |
| `terminal` | same, `owner: "terminal"` | refuses Run/Drain and every write; read-only board | proceeds — re-entrant, so a crashed earlier session reads the same record and carries on |
| `unreadable` | unparseable, not an object, unknown `owner`, or missing `since` | refuses as `terminal` does | refuses |

**Lifecycle.** The app takes ownership when the operator runs or drains a repository, and gives it up on pause, halt, and quit. A terminal cockpit takes ownership at its own preflight, the moment it starts on an `absent` record, and never gives it up on its own — there is no expiry and no automatic release, because an idle terminal looks identical to a crashed one and this app cannot tell the two apart. The operator clears a stale `terminal` record from inside the app, through **Take over**: a confirmed, explicit action that overwrites the record with `owner: "app"` and starts running. **Neither side ever edits the record to merely report state** — writing it always means taking or releasing ownership, nothing short of that.

**Implemented.** `main/dispatch/ownership.ts` is the app's own reader and writer (`readOwnership`, `takeOwnership`, `releaseOwnership`), and `plugins/port/hooks/lib/ownership-rules.mjs`'s `classifyOwnership` is its pure-JS mirror, pinned field-for-field by `scripts/checks/cockpit-ownership.ts` against a shared fixture set. The guard hook's two rules — `dispatchDenial` (the `Agent`-call arm) and `cockpitWriteDenial` (the write-tool arm) — live in the same file; the cockpit's own stand-down is the prose half of the same rail, in `PIPELINE.md` and `pipeline/PREFLIGHT.md`/`SKILL.md`.

## Why not the other options

- **Two scopes, kept — rejected.** The original design let `plan-gate` and `dispatch` move independently, so an operator could, in principle, hold one without the other. In three epics of use, nobody ever wanted that: the operator always meant "I'm running this repo now," never "just the gate" or "just dispatch." Keeping the split cost two claim reads, two denial rules, and two UX states for a distinction nobody acted on.
- **A lease with expiry — rejected.** An expiry produces a silent ownership transfer, and the app or the terminal then answers a gate the other was about to answer — a wrong decision made by a clock. A record with no expiry produces a visible stall instead, which both sides report and one operator action (Take over) clears.
- **Per-repo rather than per-checkout — rejected.** Ownership already lives at the same path every worktree resolves to (`git rev-parse --git-common-dir`), so a second operator cloning the same repository elsewhere never contends with this one's record at all. The axis that matters is "this checkout," not "this GitHub repository."

## Guard hook rules

**The dispatch arm** (`ownership-rules.mjs`'s `dispatchDenial`) denies a cockpit session's `Agent` call while the verdict is `app` or `unreadable` — the app runs this checkout, or nobody can tell who does, so the terminal cockpit launches no stage agent either way. A `terminal` or `absent` verdict denies nothing: a terminal cockpit that obeys this rule and its own preflight never races the app for a dispatch, so there is nothing left to deny once it is already running. Exempt for a subagent, since every stage agent already declares `disallowedTools: Agent`.

**The write arm** (`cockpitWriteDenial`) denies a `Write`/`Edit`/`NotebookEdit` to `.agents/cockpit.json` for every caller, including a subagent or an operator worktree — releasing or overwriting the record is a machine's own constraint, the #138 failure again if any session could clear it itself. **One exception:** a cockpit session's `Write` whose own content classifies as `owner: "terminal"` for this repository, while the record's current verdict is `absent` or `terminal` — the terminal skill's own preflight write, taking ownership the first time or re-entering after a crash. `Edit`/`NotebookEdit` never qualify for the exception: neither tool call carries the file's full intended content to classify, only a diff.

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

- **`dispatch-overtook-pause`** (the one residual race possible while ownership is absent, before either side has taken it):

  > **#52 is paused, but an agent is already running on it.** The pause landed at 14:07:12; `impl #52` was dispatched at 14:07:04. Pausing removes a label — it does not stop a running agent. Stop it from the cockpit: `stop #52`.

- **A terminal cockpit owns it** (a standing state, not a race — the gate controls are disabled, and the reason is on screen rather than in a tooltip):

  > **Your terminal cockpit answers this gate — this app owns nothing here.**

- **Ownership unreadable** (the loud stall the fail direction below chooses):

  > **`.agents/cockpit.json` can't be read.** Until it is valid or removed, this app and a terminal cockpit both stand down — nothing will answer #148. Fix or delete the file.

**The cockpit's stand-down report** (implemented in `PREFLIGHT.md`/`SKILL.md`; one line per tick, never a silent omission):

> 🖥️ **port-desktop runs this repo** since 2026-10-06T14:02Z. One cockpit per repository — this one won't start here. Pause the repo in the app (that hands it back), then run `/port:pipeline` again.

## Failure directions

Every direction below is chosen deliberately; neither side of any of them is a default (`docs/ENGINEERING.md` §4).

- **The record fails toward "nobody writes," never toward "ownership reverts."** This is why it is a record with no expiry rather than a lease: an expiry produces a silent ownership transfer, and the losing side answers a gate the operator was about to answer — a wrong decision. A record that never expires produces a visible stall instead, which both sides report and one operator action (Take over) clears.
- **An unreadable record reads as claimed, on both sides, with the reason named.** The ambiguous case is which side should run the checkout; standing both down is the only reading that cannot produce an unintended decision.
- **The hook's own read throwing stays fail-open** (`hook-error`, unchanged) — an internally broken hook must never block unrelated work. Unintelligible *data* and a failed read are different events, and are treated differently.
- **Conflict detection fails toward reporting, never toward resolving.** No write is retried, and no "overwrite anyway" control exists outside the explicit, confirmed Take over action.

## Risks / notes

**Why a prose rail is not enough, and the hook is.** Both guard rules here exist because the cockpit violated a prose rail under throughput pressure before — the shell loop (#120) and clearing its own `needsHuman` gate thirteen minutes after setting it (#138). `docs/ENGINEERING.md` §7 turns that into a rule: a rail is a checkable precondition, never "never do X". Ownership is therefore enforced twice — the cockpit reads it and stands down, and the hook denies it if the model does not. Only the second half is load-bearing.

**The app's own click plus its audit entry authorises `unblock`/`revise` (#312).** The guard hook's gate rule authorises the cockpit's own `unblock #N` from the *calling Claude session's own transcript* (`recentOperatorMessages`) — the app has no transcript, so that rule never applies to it. Instead, the app writes these two labels from its main process through `gh`, never through a Claude tool call, so the guard hook never sees them at all; the operator's own click in the app, recorded in `writes.jsonl`, is the authorisation. The hook still guards every Claude session, including the app's own hosted dispatcher and operator sessions — this changes nothing about the hook, it only documents a write path the hook was never positioned to see.

**A stale `terminal` record after a crashed or closed terminal session blocks the app until Take over.** This is deliberate: it fails toward a visible stall, never a silent handover (§4). The dialog copy states plainly that the app can't tell whether the terminal is still running.

## Follow-up

The guard hook rules above are enforced; a mixed-version checkout — a terminal cockpit started before this change ships, still reading `.agents/gate-claim.json` — is not supported. A leftover `gate-claim.json` is ignored and harmless; `RECOVERY.md` says to delete it.
