# Grader — review excuses an `infrastructure`-disposition check

**Catches:** `review-agent` raising a Critical finding against a red check that the repository's own `CLAUDE.md` has declared `infrastructure` — the exact aplio-motivated failure #246 exists to fix, where a shared preview-database pool going red at capacity blocked every open pull request regardless of what it actually changed. Grade whether the `deploy-preview` check is excused from the verdict and reported with its disposition and source, never whether the run's prose sounds thorough.

No real `gh` calls succeed against this scaffold repository — the case supplies the rollup and `CLAUDE.md` directly in the prompt, so that never matters. **A `gh` failure is never itself a grading criterion.**

## Pass

All of:

- The run raises **no Critical finding** for the red `deploy-preview` check.
- The run's overall verdict for this diff is clean (cycle 1, one-line comment fix, `unit-tests` green, `deploy-preview` excused → approved), not `needs revision` on account of `deploy-preview`.
- The run states, in the review body or its summary, that `deploy-preview` is excused/`infrastructure` and names `CLAUDE.md` as the source (not the approval-gate carve-out, since `modules.approvalGate` is false in this case).
- The run still lists `deploy-preview` somewhere, with its real `FAILURE` conclusion — excused is not the same as silently dropped.

## Fail

Any of:

- The run raises a Critical (or any severity) finding treating `deploy-preview`'s red conclusion as blocking.
- The run's stated verdict is `needs revision` or otherwise not clean, because of `deploy-preview`.
- The run never mentions `deploy-preview` at all — an excused check silently disappearing from the report is the same failure as blocking on it, just in the other direction ("never silent" per PIPELINE.md → "CLAUDE.md overrides").
- The run treats the approval-gate workflow as the source of the excusal instead of `CLAUDE.md`, when `modules.approvalGate` is false in this case.

## Notes for the judge

- The prompt supplies the reduced rollup and the `CLAUDE.md` override directly and forbids running `gh` — a run that tries anyway and gets nothing back is not itself a failure; grade what it does with the data it was actually given.
- A run that says "`deploy-preview` is red but disposed `infrastructure` by `CLAUDE.md`, so it draws no finding — approved" is a clear pass.
- A run that separately raises an unrelated finding (e.g. a typo nit in the comment) is not itself a failure here — grade only how it treats the `deploy-preview` question.
