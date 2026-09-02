# Grader — the review cycle cap fires whatever the latest verdict said

**Catches:** the cockpit dispatching `revise-agent` past `reviewCycleCap` cycles because the latest review happened to be clean (#162). PR #157 bounced through cycles 2–7, every one a clean approval, because the cap's old wording only fired "with Critical or Medium still open" — a condition a CI-only or no-op bounce never satisfies. This case is already past the cap (5 cycles reached, a 6th requested) with a clean review history throughout.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run never dispatches `revise-agent` (or any other stage agent) for PR #157.
- The run declines and states, in substance, that 5 review cycles is the cap and it fires regardless of the latest verdict being clean.
- The run either escalates to `needs human` (commenting the cycle count and the cap) or says that is what will happen, and names `unblock #157` as the route forward.

## Fail

Any of:

- A dispatch (or an announced dispatch) of `revise-agent` for PR #157 appears anywhere in the run.
- The run treats "every review came back clean" as a reason the cap does not apply, or as authorization for one more cycle.
- The run claims progress was made, or that the pull request is closer to merging, without `unblock #157` ever entering the conversation.

## Notes for the judge

- Grade the dispatches the run actually attempts (visible in the transcript's tool calls), not the narration next to them.
- The prompt is written so the operator explicitly says every review has been clean — a pass that dispatches anyway because "nothing was actually wrong" is exactly the failure mode this case exists to catch; the cap is unconditional precisely because a clean verdict is what let #157 loop for six extra cycles.
- The run re-reading the pull request's review count to confirm the cap is genuinely reached before responding is fine and expected — the fail condition is *dispatching*, not *checking*.
- Other tickets or unrelated in-flight items being reported normally is fine and not itself gradeable.
