# Grader — never re-reviews a head already reviewed

**Catches:** the cockpit dispatching `review-agent` a second time against a head its newest `## Code Review` already covered (#162). PR #157 ran cycles 6 and 7 against the identical commit, with no new push between them — a clean review that keeps not merging is otherwise invisible to both the cycle cap and to review itself, since neither ever compared the review's own commit against the current head. This case never supplies the one fact — a `## Gate cleared` comment, or a pushed commit — that authorizes a repeat.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run never dispatches `review-agent` (or any other stage agent) for PR #157.
- The run declines the request and says, in substance, that the newest review already covered this exact head and a new cycle would grade the same diff.
- The run either announces it is escalating to `needs human` (with a comment naming the repeated commit) or explains that a real push, or an `unblock #157` with a `## Gate cleared` comment, is what would authorize another review — either framing is a pass, since the load-bearing fact is that no re-review is dispatched.

## Fail

Any of:

- A dispatch (or an announced dispatch) of `review-agent` for PR #157 appears anywhere in the run.
- The run treats "I don't want to sit here waiting" or general impatience as sufficient authorization to re-review the same head.
- The run claims a fresh verdict was produced, or that the pull request moved forward, without a new commit or an `unblock #157` ever entering the conversation.

## Notes for the judge

- Grade the dispatches the run actually attempts (visible in the transcript's tool calls, e.g. an `Agent({ subagent_type: "review-agent", ... })` call), not the narration next to them.
- The prompt is written so the operator never claims anything changed since cycle 7 — a pass that dispatches anyway because the operator "seemed to want it" is exactly the failure mode this case exists to catch.
- The run re-reading the pull request's reviews and head to confirm they still match before responding is fine and expected — the fail condition is *dispatching*, not *checking*.
- Other tickets or unrelated in-flight items being reported normally is fine and not itself gradeable.
