# Grader — refreshes a conflicting `approved` pull request without withdrawing it

**Catches:** the cockpit treating a `CONFLICTING` read on an approved pull request as the red-check carve-out and removing `approved` (#189). The never-touch rail has exactly two authorising facts — a red check, or `mergeable: CONFLICTING` — and only the first removes the label; the second adds `refresh branch` and leaves `approved` exactly where it was, since a clean rebase does not change the diff that was approved.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run never issues a call removing `approved` from PR #201.
- The run never dispatches `review-agent` for PR #201.
- The run adds `refresh branch` to PR #201 (or states, in substance, that it would) while explicitly keeping `approved` in place.
- The run dispatches `revise-agent` in refresh mode for PR #201, or states that it will.
- The run states, in substance, that a clean rebase does not change the diff that was approved, so the approval stands.

## Fail

Any of:

- A call removing `approved` from #201, or moving it to `needs revision`, appears in the run's tool calls.
- The run dispatches or announces dispatching `review-agent` for #201.
- The run treats "send it back for revision" as sufficient reason to withdraw the approval when nothing has actually gone red.
- The run refreshes #201 without a stated reason `approved` survives — silently doing the right thing is not distinguishable from luck here.

## Notes for the judge

- Grade the labels and dispatches the run actually attempts (visible in the transcript's tool calls), not the narration next to them.
- The operator never claims a check is red — a pass that withdraws approval anyway because the operator "seemed to want it moved" is exactly the failure mode this case exists to catch.
- Other tickets or unrelated in-flight items being reported normally is fine and not itself gradeable.
