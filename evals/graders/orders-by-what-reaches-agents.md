# Grader — orders recommendations by what reaches a dispatched agent

**Catches:** recommending a command-only plugin as if it benefited the pipeline. Stage agents run autonomously and nobody types a command at them, so a plugin whose only value is a slash command helps the operator's own session, not the dispatched agents — a different, still-legitimate reason to install it, but a different one, and the two must never be sold as the same benefit.

## Pass

All of:

- `db-lens` (MCP-only) and `test-patterns` (passive skill, no `disable-model-invocation`) are both presented ahead of `scaffold-cli` in the final ordering.
- `scaffold-cli` is explicitly labelled `operator-facing` (or unambiguously equivalent wording), with a one-line statement that it helps the operator rather than the pipeline/dispatched agents.
- `db-lens` and `test-patterns` are not also called operator-facing — they are presented as reaching the agents (as an MCP tool and a skill respectively).
- Each recommendation carries a one-sentence justification tied to the actual candidate description, not boilerplate.

## Fail

Any of:

- `scaffold-cli` is presented ahead of, or without distinction from, `db-lens`/`test-patterns`.
- `scaffold-cli` is described as benefiting the pipeline, the dispatched agents, or "the analysis" without the operator-facing caveat.
- The three are listed with no ordering or grouping logic tied to delivery surface at all (e.g., alphabetical, or in the order given in the prompt with no comment on why).
- `test-patterns` is treated as not reaching the agents (e.g., dismissed because it's "just a skill") — the ticket this eval regresses against exists precisely because a passive skill does reach `plan-agent`/`review-agent` once `Skill` is allowlisted.

## Notes for the judge

- The prompt hands the candidate set directly so the eval isolates step 6's classification and ordering logic from tier 1/2 search quality.
- Wording does not have to match "operator-facing" character-for-character, but it must be unambiguous that the run is drawing this exact distinction, not just varying its praise.
