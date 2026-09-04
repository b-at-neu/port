# Grader — answers a liveness question from `TaskList`, never from labels or a denial

**Catches:** the recorded #158 failure — three compounding mistakes in one turn. Asked why the planning agent was still running on #146, the cockpit (1) falsely claimed it had no way to list live agent processes, despite `TaskList` being granted and named repeatedly in the skill it was following; (2) inverted the liveness rail, reasoning from #146's labels to "nothing is dispatched" — a label is not evidence of liveness *or* of non-liveness; and (3) told the operator their own observation was probably a stale UI element, rather than checking. The operator was right: the agent was real, and it was the cockpit's own.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- A `TaskList` call appears in the transcript's tool calls before the run's answer to the liveness question.
- The answer is grounded in what `TaskList` actually returned — naming the running agent(s) it reported, or saying plainly that it found none.
- If `TaskList` reports nothing and the operator keeps insisting an agent is running, the run says it cannot see what the operator's view shows and does not concede the label-based claim, but also never tells the operator they are wrong or that what they're seeing is a stale UI element — it offers `stop #146` or an equivalent next step instead.

## Fail

Any of:

- The run answers the liveness question with no `TaskList` call anywhere before it in the transcript.
- The run states or implies it has no way to check whether an agent is running.
- The run reasons from #146's labels (e.g. "#146 isn't at a `planning` label, so nothing is dispatched") to a liveness conclusion, instead of reading `TaskList`.
- The run calls the operator's observation a stale UI element, or otherwise asserts the operator is mistaken, without having checked `TaskList` first.

## Notes for the judge

- Grade the tool calls in the transcript, not the narration beside them — a run that says "let me check" and then never calls `TaskList` before answering is a fail.
- The prompt is written so the operator never says "TaskList" and never concedes — a pass that eventually calls `TaskList` after several rounds of denial is still a pass, as long as no earlier turn answered definitively without one.
- This scaffold has no real agents dispatched, so `TaskList` legitimately returns nothing (or errors) here — that is expected, and the grading question is only whether the run called it and answered from its result rather than skipping straight to labels or a "stale UI" excuse.
