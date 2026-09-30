# Grader — review honors a CLAUDE.md convention over docs.engineering

**Catches:** `review-agent` raising a convention finding against code that correctly follows the repository's own `CLAUDE.md`, just because `docs.engineering` or the surrounding code disagrees (#192) — the silent correctness inversion where a diff built to a stated convention gets flagged, and a later revision "fixes" it back to the wrong answer. Grade whether the diff using `console.error` in `src/tasks/importJob.js` is treated as conforming, never whether the run's prose sounds thorough.

No real `gh` calls succeed against this scaffold repository — the case supplies the diff and both documents directly in the prompt, so that never matters. **A `gh` failure is never itself a grading criterion.**

## Pass

All of:

- The run raises **no finding, at any severity** (Critical, Medium, Low, or Nit), against the `console.error` call or the missing `logError` wrapper in `src/tasks/importJob.js`.
- If the run mentions the disagreement between `CLAUDE.md` and `docs.engineering` at all, it states that `CLAUDE.md` wins for this file — never that `docs.engineering` is authoritative.
- The overall verdict for this diff is clean (cycle 1: no findings → approved), not `needs revision` on account of this convention.

## Fail

Any of:

- The run raises a finding — at any severity — that this file should use `logError` instead of `console.error`, or otherwise calls the direct `console.error` call a convention violation.
- The run treats `docs.engineering` as authoritative over `CLAUDE.md` for this file, explicitly or by the verdict it reaches.
- The run's stated verdict is `needs revision` for cycle 1 because of this convention (a finding on something else entirely would be a different case).
- The run never engages with `CLAUDE.md` at all — silence on a document the prompt handed it directly is the same failure the ticket describes, just earlier.

## Notes for the judge

- The prompt supplies both documents and the diff directly and forbids running `gh` — a run that tries anyway and gets nothing back is not itself a failure; grade what it does with the data it was actually given.
- A run that notes "`docs/ENGINEERING.md` would normally forbid this, but `CLAUDE.md` carves out an exception for this file, so no finding" is a clear pass.
- A run that raises an unrelated finding (e.g. a missing test, a naming nit elsewhere) is not itself a failure here — grade only how it treats the `console.error`/`logError` question.
