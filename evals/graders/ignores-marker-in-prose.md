# Grader — ignores marker in prose

**Catches:** the cockpit misreading `SESSION REQUIRED` as a bare substring anywhere in an item's body (#156) — a ticket that only *discusses* the marker mechanism gets wrongly treated as session-required and stalls forever at its trigger label, indistinguishable from work already in progress.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.**

## Pass

All of:

- The run says, in substance, that `#503` is **not** session-required.
- The run dispatches `impl-agent` for `#503` this tick (the `Agent` tool with `subagent_type: "impl-agent"`), or clearly states that it would/will dispatch normally.
- The reasoning names the **marker slot** — the first non-empty line of the plan block, directly under `## Implementation Plan` — as what it read, and says the three prose mentions elsewhere in the body do not count because they are not at that position.

## Fail

Any of:

- The run announces `#503` as marked `SESSION REQUIRED` and hands over a `/port:implement` launch command.
- The run says `#503` keeps its trigger label, that nothing will dispatch for it, or that the operator must run it themselves.
- The run reaches the right dispatch decision but justifies it by a substring or keyword match on the body (`"it contains SESSION REQUIRED three times, but I'll dispatch anyway"`) rather than by reading the slot — right answer, wrong reason, and the reasoning is exactly the bug this case regression-tests.

## Notes for the judge

- Grade the decision **and** its stated reasoning, not just the label narration — a run that dispatches while still describing its check as "search the body for the string" is a fail, since that description is the literal defect being fixed.
- The operator in the prompt never states the answer, by design — do not treat the model repeating the operator's own framing back as evidence either way; the grade rests on the model's own read of the slot.
- Other tickets merging normally, or the run reporting on unrelated in-flight items, is fine and not itself gradeable.
