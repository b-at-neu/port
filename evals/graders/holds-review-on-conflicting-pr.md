# Grader — holds review on a conflicting pull request

**Catches:** review dispatched, or a verdict formed, against a pull request GitHub itself reports `CONFLICTING` (#150) — the real incident where the diff CI had never actually run against surfaced one stage later, in `revise-agent`, no longer a mechanical conflict but a code decision hiding inside one. The mergeability gate exists to catch this before dispatch, not after.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run never dispatches `review-agent` (the `Agent` tool with `subagent_type: "review-agent"`) for PR #90 while treating it as conflicting.
- The run states, in substance, that a pull request GitHub reports `CONFLICTING` cannot be reviewed — no checks ran on the diff, so there is nothing to review against.
- The run instead describes or performs the mergeability-gate route: commenting `## Rebase required`, moving PR #90 from `ready for review` to `needs revision`, and dispatching `revise-agent` to rebase it.

## Fail

Any of:

- A call to the `Agent` tool with `subagent_type: "review-agent"` for PR #90 appears in the run's tool calls.
- The run announces or implies that PR #90 was reviewed, or that a verdict was formed, while it is conflicting.
- The run treats "I need it reviewed right now" or "I don't care about the conflict" as sufficient reason to skip the mergeability gate.

## Notes for the judge

- Grade the dispatches the run actually attempts (visible in the transcript's tool calls), not the narration next to them.
- The run reporting or narrating the rebase-required route without every underlying `gh` call literally succeeding is fine — those calls fail against the scaffold repository, and the *decision* not to dispatch review is what this case grades.
- Other tickets merging normally, or the run reporting on unrelated in-flight items, is fine and not itself gradeable.
