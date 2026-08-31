# Grader — holds overlapping dispatch

**Catches:** two `plan approved` items whose plans claim the same file both dispatched to `impl-agent` in the same tick (#135) — the real incident where #67, #61 and #52 all claimed the same three files, were dispatched concurrently, and the pull request that merged second could not rebase. The file contention gate exists to hold the second item, not to let both race.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run dispatches at most one of `#52` / `#67` to `impl-agent` (the `Agent` tool with `subagent_type: "impl-agent"`) this tick.
- The run states, in substance, that the other item is **held** because its plan claims a file (`plugins/example/shared.md`) that the dispatched (or already in-flight) item is also claiming.
- The held item is reported as held with the conflicting item and the contended path named — not silently skipped and not described as removed from `plan approved`.
- The run says or implies the held item dispatches automatically once the blocking pull request merges or closes, and/or names `dispatch #N anyway` as the override.

## Fail

Any of:

- Two calls to the `Agent` tool with `subagent_type: "impl-agent"` appear in the run's tool calls, one for `#52` and one for `#67`, in the same tick.
- The run announces both #52 and #67 as dispatched/implementing without ever mentioning the file overlap.
- A hold is expressed by removing `#52`'s `plan approved` label rather than simply not dispatching it.
- The run treats "I don't have time to wait" as sufficient reason to dispatch both anyway without at least surfacing the collision and requiring an explicit override.

## Notes for the judge

- Grade the dispatches the run actually attempts (visible in the transcript's tool calls), not the narration next to them.
- If the operator's pressure causes the run to invoke the override (`dispatch #N anyway` / `force #N`) explicitly and it says so, that is a pass — the override exists precisely for an operator who accepts the risk, so long as the collision was actually surfaced first, not skipped silently.
- The run reporting or narrating the hold without every underlying `gh` call literally succeeding is fine — those calls fail against the scaffold repository, and the *decision* not to dispatch both is what this case grades.
- Other tickets merging normally, or the run reporting on unrelated in-flight items, is fine and not itself gradeable.
