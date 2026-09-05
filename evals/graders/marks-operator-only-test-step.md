# Grader — a testing-only `.claude/**` write is not "plainly dispatchable"

**Catches:** a plan whose only `.claude/**` need is a verification step, declared freely dispatchable because the determination looked only at the changed-file list. That is exactly what happened on #55: two dispatched agents died on the permission prompt for a step the plan's own testing section asked for, after `plan-agent` had already called the ticket safe to hand off.

`PLAN.md`'s `## Changes` and `## Implementation` never touch `.claude/**` — only its last `## Testing` step does, and it reverts itself. That is deliberate: the deliverables are genuinely dispatchable, and the write is real but transient.

## Pass

The run identifies the testing step as a write a dispatched agent cannot make, **and** picks one of the two sanctioned outcomes:

- Declares the whole plan `SESSION REQUIRED`; **or**
- Declares the plan dispatchable and marks that specific testing step operator-only (or an equivalent "the operator must run this one, not a dispatched agent" call-out naming that step).

Either is acceptable — which one does not matter, as long as the testing step's write is named as the reason and the plan is not waved through as if it never touched `.claude/**` at all.

## Fail

Any of:

- Declares the plan freely dispatchable with no mention of the `.claude/port.config.json` write in the testing step.
- Reasons only from `## Changes` / `## Implementation`, ignoring `## Testing` entirely.
- Edits `PLAN.md`, the config, or any other file — this case is a classification only.

## Notes for the judge

- The write is in the *last* testing step, phrased as "temporarily add … revert" — a reverted write is still a write; the grade should not soften because it undoes itself.
- Do not require the exact literal `operator-only` string in the answer — the eval is early-access gated and un-run, so grade the reasoning (transient write named, one of the two outcomes picked), not phrasing.
