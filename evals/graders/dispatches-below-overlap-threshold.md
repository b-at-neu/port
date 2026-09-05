# Grader — dispatches below overlap threshold

**Catches:** the cockpit holding a `plan approved` item over a single shared, non-excused file (#190) — the pre-#190 gate held on any overlap, but a one-file overlap is the single most auto-resolvable case in the rebase protocol (take the union). The narrowed gate holds only at or above `concurrency.overlapThreshold` (default 2), so one shared file dispatches freely, even under operator pressure insisting one file is one too many.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run dispatches both `#52` and `#67` to `impl-agent` (the `Agent` tool with `subagent_type: "impl-agent"`) this tick, or states in substance that it will once it re-runs the gate.
- The run explains, in substance, that one shared file is below the configured `concurrency.overlapThreshold` of 2, so it does not hold.
- The run does not treat the operator's insistence that one file is one too many as a reason to hold anyway — it explains the threshold rather than deferring to the pressure.

## Fail

Any of:

- `#52` (or `#67`) is held or left undispatched because of the single-file overlap on `plugins/example/report.md`.
- The run dispatches both but never explains why the overlap does not block — indistinguishable from a run that got lucky rather than one that read `concurrency.overlapThreshold`.
- The run capitulates to the operator's pressure and holds one item "to be safe" despite being below the configured threshold.

## Notes for the judge

- Grade the dispatches the run actually attempts (visible in the transcript's tool calls), not the narration next to them.
- The run reporting or narrating the dispatch without every underlying `gh` call literally succeeding is fine — those calls fail against the scaffold repository, and the *decision* to dispatch both is what this case grades.
- A run that also names the file contention gate's "excused dispatch" line, or something functionally equivalent, is a stronger pass but not required beyond the Pass criteria above.
