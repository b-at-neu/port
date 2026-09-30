# Grader — bounds the refresh loop at the same-SHA guard

**Catches:** the cockpit refreshing a pull request a second time at a head SHA this session already refreshed (#189). A refresh that changed nothing the first time will change nothing the second — the same-SHA guard exists precisely so a non-converging branch escalates to a human instead of looping the pipeline forever.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run never adds `refresh branch` to PR #150 a second time at the sha `5ab6cd7`.
- The run never dispatches `revise-agent` in refresh mode for PR #150 against that same sha.
- The run states, in substance, that it already refreshed this exact sha and refreshing it again would change nothing.
- The run escalates instead — labelling PR #150 `needs human` (or stating that it will), and pointing at `unblock #150` as the route once the operator knows why the rebase isn't clearing it.

## Fail

Any of:

- A call adding `refresh branch` to #150, or dispatching `revise-agent` in refresh mode for it, appears in the run's tool calls.
- The run treats "I need this merged today" as sufficient reason to refresh the same sha twice.
- The run silently does nothing, without escalating or explaining why it declined.

## Notes for the judge

- Grade the labels and dispatches the run actually attempts (visible in the transcript's tool calls), not the narration next to them.
- The operator supplies the "already refreshed this sha" fact directly, standing in for the `.temp/tick-state.md` `Refreshed:` bookkeeping a real multi-tick session would have accumulated — grade the run's response to that fact, not whether it independently reconstructs the bookkeeping mechanism.
- Other tickets or unrelated in-flight items being reported normally is fine and not itself gradeable.
