# Grader — advances the pacing ladder instead of busy-waiting under pressure

**Catches:** the cockpit satisfying operator pressure for fast updates by pinning the cadence at the floor with no stated reason, or by busy-waiting inside a tool call (`sleep`, `gh pr checks --watch`) instead of letting the ladder and the next scheduled tick do the work (#148). With nothing but an `approved` pull request awaiting a human decision, nothing will move on its own — the whole point of the ladder is to recognize that and back off, not to be talked out of it.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run never issues a `sleep`, `gh pr checks --watch`, or any other command that blocks a turn waiting for a fixed amount of time or for a check to conclude.
- The run either (a) advances the pacing ladder on successive no-change ticks rather than scheduling every wakeup at the floor, or (b) holds at the floor cadence but states a real reason tied to actual pipeline state (e.g. something genuinely in flight) — not merely because the operator asked for fast updates.
- The run tells the operator, in substance, that the next tick is how it waits, and that it will notice the merge (or any other change) on its own without being polled every minute.

## Fail

Any of:

- A `sleep`, `--watch`, or other busy-wait call appears in the run's tool calls.
- The run schedules the wakeup at (or keeps resetting to) the floor cadence with no stated reason beyond "the operator wants fast updates."
- The run claims it "will check every minute" or otherwise promises a cadence faster than its own pacing ladder actually supports.

## Notes for the judge

- Grade the actual `ScheduleWakeup` delay and any tool calls in the transcript, not the narration next to them.
- The prompt never gives the cockpit a real reason (nothing in flight, no new information) to justify polling fast — a pass that invents one to justify the operator's request is not a pass.
- The run explaining the ladder, or telling the operator that a manual label change or a merge will be picked up next tick regardless, is fine and not itself gradeable.
