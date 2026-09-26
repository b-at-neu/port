# Grader — impl-agent adopts a pushed branch and skips landed items

**Catches:** a retried `impl-agent` treating an empty-looking fresh worktree as proof that nothing has been done yet (#254) — a killed run's checkpoint-pushed branch sits on `origin` with no pull request, and the obvious, unexamined path is to re-implement every checklist item from scratch, duplicating or redoing items 1 and 2. The live cost this regresses: at least 8 of ~28 dispatched tickets in a 14-day audit needed a second attempt, and every earlier attempt was pure loss.

## Pass

All of:

- The run's `git ls-remote --heads origin "254-*"` (or equivalent lookup) finds `254-add-rate-limiting` and adopts it **by that exact name** — not a newly derived slug, not a fresh branch cut from `main`.
- Items 1 and 2 (`lib/rate-limit.ts` and the wiring in `server/handler.ts`) are recognized as already landed on the adopted branch — the run inspects the actual tree (Read/Grep-equivalent, or an explicit statement of having checked file contents) rather than trusting commit subjects alone, and does **not** re-apply, duplicate, or overwrite either.
- Items 3 and 4 (`docs/RATE_LIMITING.md`, `tests/rate-limit.test.ts`) are implemented and committed on top of the adopted branch.
- The final report states plainly which branch was adopted, which items were found already done, and which were newly implemented.
- No `gh pr create` (or any `gh` invocation) appears in the transcript — there is no `gh` in this sandbox, and the prompt asked the run not to attempt it.

## Fail

Any of:

- The run creates a new branch (any name other than `254-add-rate-limiting`) instead of adopting the existing one, or ignores the existing branch entirely and works on `main`.
- Item 1 or item 2 is redone, duplicated, or its existing content is overwritten with an equivalent-but-different implementation.
- The run ticks off item 1 or item 2 as done purely because a commit subject says so, without any indication the actual file contents were checked.
- Items 3 and 4 are left unimplemented, or the run stops after adopting the branch without finishing the checklist.
- The run attempts a `gh` command and either fabricates a result or stalls on the failure instead of proceeding with the sandbox's stated facts.

## Notes for the judge

- The run may actually execute the `git` commands (Bash is available and `origin` is a real local bare repository), or describe the resolution precisely enough to grade against these criteria without completing every command — grade the described or actual outcome, not the mechanism.
- A run that re-reads `lib/rate-limit.ts` and `server/handler.ts`, confirms they already satisfy items 1–2, and says so explicitly before moving on to items 3–4 is exactly the intended behaviour — do not fail it for spending a turn confirming rather than assuming.
- Cosmetic differences in the new `docs/RATE_LIMITING.md` or `tests/rate-limit.test.ts` content are fine; grade whether the checklist items exist and are wired up, not exact wording.
