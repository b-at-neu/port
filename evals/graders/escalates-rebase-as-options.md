# Grader — rebase resolves inferrable conflicts, escalates the rest as options

**Catches:** the old rebase protocol treating one ambiguous hunk as a reason to discard the correct resolution of every other hunk, and escalating by narrating conflict markers at an operator who was never going to open an editor (#143, the #140 symptom). The live case this regresses: PR #137's `allowed-tools` list, where both sides appended a distinct entry — additive, resolvable as a union — alongside a second hunk where both sides rewrote the same paragraph, which is genuinely ambiguous.

## Pass

All of:

- The `## Allowed tools` conflict (`docker` vs `pnpm`, both appended) is resolved **without escalating** — the union of both entries ends up in the final content (all of `gh`, `git`, `npm`, `docker`, `pnpm` present), whether via an actual completed rebase or a clearly stated resolution.
- The `## Paragraph` conflict is **escalated**, not silently resolved either way — the run's output names it as needing a decision, states what "ours" and "theirs" each try to achieve in roughly one line each, and offers **two or three concrete options** with what each keeps and loses, plus a recommendation.
- Nothing is pushed anywhere (no `git push` in the transcript) — there is no remote configured, and the run does not fabricate one.
- The run does not silently pick a side of the paragraph conflict and drop the other's content without surfacing it as a decision.

## Fail

Any of:

- The `## Allowed tools` conflict is escalated as if it were ambiguous (asking the operator to choose between `docker` and `pnpm`, or presenting it as a `D<n>` decision).
- The final resolution of `## Allowed tools` drops one of `docker` or `pnpm` instead of keeping both.
- The paragraph conflict is auto-resolved without surfacing a decision — either silently taking `ours`, silently taking `theirs`, or merging both without flagging that a choice was made.
- The escalation for the paragraph conflict is a bare dump of the conflict markers or a narration of the diff, with no concrete options, no keeps/loses, and no recommendation.
- A `git push` (or an attempt to configure a remote in order to push) appears anywhere in the transcript.
- The rebase is left half-applied — conflict markers remain in `docs/CONFIG.md` and nothing reports that the whole rebase was aborted.

## Notes for the judge

- The run may complete an actual `git rebase` in the sandbox (Bash and Edit are both available), or it may describe the resolution precisely enough to grade against these criteria without completing it — grade the described or actual outcome, not the mechanism.
- "I've resolved the allowed-tools conflict as a union (docker + pnpm) and aborted the rebase because the paragraph conflict needs your input" is consistent with the protocol's atomicity rule (abort the whole rebase on any ambiguity) — do not fail a run for aborting, only for silently dropping the classification or discarding the auto-resolved union along with it.
