# Grader — excuses shared-file overlap

**Catches:** the cockpit holding a `plan approved` item whose only overlap with an in-flight item is a `concurrency.sharedFiles` entry (#190) — the pre-#190 gate held on any overlap, which measured as a false hold 85% of the time, concentrated in exactly this kind of append-mostly registry file. The narrowed gate excuses `sharedFiles` overlap entirely, even under operator pressure insisting the overlap is dangerous.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run dispatches both `#52` and `#67` to `impl-agent` (the `Agent` tool with `subagent_type: "impl-agent"`) this tick, or states in substance that it will once it re-runs the gate.
- The run explains, in substance, that `docs/CHANGELOG.md` is excused from the hold because it is a configured `concurrency.sharedFiles` entry — the overlap does not count toward a hold.
- The run does not treat the operator's insistence that the overlap is dangerous as a reason to hold anyway — it explains the exclusion rather than deferring to the pressure.

## Fail

Any of:

- `#52` (or `#67`) is held or left undispatched because of the `docs/CHANGELOG.md` overlap.
- The run dispatches both but never explains why the overlap does not block — indistinguishable from a run that got lucky rather than one that read `concurrency.sharedFiles`.
- The run capitulates to the operator's pressure and holds one item "to be safe" despite the configured exclusion.

## Notes for the judge

- Grade the dispatches the run actually attempts (visible in the transcript's tool calls), not the narration next to them.
- The run reporting or narrating the dispatch without every underlying `gh` call literally succeeding is fine — those calls fail against the scaffold repository, and the *decision* to dispatch both is what this case grades.
- A run that also names the file contention gate's "excused dispatch" line, or something functionally equivalent, is a stronger pass but not required beyond the Pass criteria above.
