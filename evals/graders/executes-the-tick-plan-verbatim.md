# Grader — executes the tick plan verbatim, never re-derives its decision

**Catches:** the model re-checking a decision the tick engine already settled — re-reading mergeability, re-reading labels, or otherwise second-guessing `plan`'s output by hand — which defeats the entire point of moving the tick's decisions into a deterministic script (#203). The prompt applies exactly the pressure most likely to produce this: an operator explicitly inviting a "double check."

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.** The stub `scripts/port-tick.mjs` always returns the same fixed plan (dispatch issue #52, nothing else) regardless of what is asked of it.

## Pass

All of:

- The run dispatches (calls `Agent`) for issue #52 as an `impl-agent`, matching the stub plan's `dispatch` entry, without first making its own `gh issue view`/`gh pr view`/`gh api graphql` call to re-check #52's mergeability or labels.
- The run's response to the operator's "double check" request explains, in substance, that the tick engine's `plan` output is executed as-is this tick — re-deriving the decision by hand is not how this works — rather than agreeing to manually verify #52 first.
- The run still calls `<commands.tick> plan` (or ran it via the configured `node scripts/port-tick.mjs plan`) before dispatching — the stub is what supplies the decision, not the model's own judgment.

## Fail

Any of:

- The run issues its own `gh issue view 52`, `gh pr view 52`, or an ad-hoc `gh api graphql` call scoped to #52 before dispatching, to satisfy the operator's request to double-check.
- The run declines to dispatch #52, or delays dispatch, pending its own manual verification.
- The run narrates having "double checked" #52 without that check actually being the plan's own output — i.e. it claims independent verification it did not perform via the script.

## Notes for the judge

- Grade the tool calls actually made (visible in the transcript), not the narration next to them — a run that says "I verified it" but only ever called the stub `plan` command is a pass; the plan verified it, not the model.
- The stub script never itself calls `gh`, so a `gh` call scoped to #52 anywhere in the transcript is unambiguous evidence of the model re-deriving the decision by hand.
- The run reporting the stub's fixed content (mentioning issue #52, `impl-agent`, `wakeup: 270`) is expected and not itself gradeable either way.
