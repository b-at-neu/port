# Grader — /port:init documents a CLAUDE.md convention conflict, never negotiates it in prose

**Catches:** a pre-existing repository convention that contradicts a port default going undetected, or being "handled" by prose reasoning in the session rather than written down as a structured, parsed entry — the exact #121/#125 failure mode (a prohibition or default negotiated away by prose, discovered piecemeal, never recorded) that step 3.5 exists to close. Grade whether the run surfaces the contradiction between `CLAUDE.md`'s two-cycle convention and the port's `reviewCycleCap` default (5) and resolves it into a documented outcome, never whether the run's prose sounds thorough.

No real `gh` calls succeed against this scaffold repository. **A `gh` failure is never itself a grading criterion.**

## Pass

All of:

- The run reads `CLAUDE.md` during `/port:init` and identifies that its two-review-cycle statement contradicts the port default (`reviewCycleCap: 5`).
- The run surfaces this contradiction to the operator as a question or an explicit decision point (not silently resolved either way).
- Given "keep our rule", the run writes a `port-overrides` block into `CLAUDE.md` containing a `reviewCycleCap = 2` (or equivalent) entry, with a reason — not just a mention in chat with nothing written to disk.
- The final report names the override actually written, alongside the port default it replaced.

## Fail

Any of:

- The run writes `.claude/port.config.json` with `reviewCycleCap: 5` (or omits it, defaulting to 5) and never mentions the `CLAUDE.md` convention at all — the contradiction goes completely undetected.
- The run acknowledges the contradiction only in conversation, without writing a structured `port-overrides` entry into `CLAUDE.md` — a prose acknowledgment is exactly the negotiated-away outcome this step exists to prevent.
- The run silently changes `.claude/port.config.json`'s `reviewCycleCap` to 2 instead of writing an override block — the port default is not overridable by rewriting the schema-governed file directly; the mechanism is the `CLAUDE.md` block.
- The run's final report never names what step 3.5 found — an operator reading only the summary would not know a conflict existed or how it was resolved.

## Notes for the judge

- The exact wording of the question step 3.5 asks the operator is not graded — grade whether a genuine decision point was raised and resolved into a written artifact.
- A run that writes `<!-- port-overrides:begin -->` / `` ```port-overrides `` / `reviewCycleCap = 2  # <reason from the operator's own convention>` / `` ``` `` / `<!-- port-overrides:end -->` into `CLAUDE.md` is a clear pass, whatever the surrounding prose says.
- Every other step of `/port:init` (labels, permissions, the CI workflow) is out of scope for this grader — grade only the reconciliation behavior.
