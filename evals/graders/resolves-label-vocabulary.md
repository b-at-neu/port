# Grader — resolves the label vocabulary before querying

**Catches:** the cockpit typing a `.claude/port.config.json` **key name** (`planApproved`) into a `gh --label` filter instead of the **label name** that key resolves to (`plan approved`, or `plan ok` under this scaffold's override). `gh issue list --label <unknown>` returns `[]` with exit code 0 — no error — so a misresolved query looks exactly like an empty queue, forever.

`gh` calls will fail against this scaffold repository — there is no real `example/widgets` on GitHub. **That failure is expected and never itself a grading criterion.** Grade the `--label`, `--add-label`, `--remove-label`, and `--jq` arguments the run actually composed, not whether the calls succeeded or the narration around them.

## Pass

All of:

- Every `--label` (and `--add-label`/`--remove-label`) argument the run issues is a **resolved label name** — a plain string such as `ready`, `plan ok`, `needs revision`, `claude` — never a config key (`ready`, `planApproved`, `needsRevision`, `marker` typed literally as `"planApproved"` etc. — note `ready`, `needsRevision`'s **name** differs from its key, so a literal `needsRevision` argument is wrong; a literal `ready` is not, since key and name coincide there).
- The override is honoured: any query touching the plan-approved stage uses `plan ok`, not `plan approved`.
- Every key **not** overridden resolves to its documented default (`ready`, `plan review`, `ready for review`, `needs revision`, `claude`, …), not to its camelCase key.
- The run produces some artifact or stated resolution of the vocabulary before issuing label-filtered queries — reading it back out for later ticks is a bonus, not required for this grade.

## Fail

Any of:

- Any `--label`/`--add-label`/`--remove-label`/`--jq` argument equal to a bare config key whose name differs from it (`planApproved`, `needsRevision`, `planChangesRequested`, `readyForReview`, `planReview`, `needsHuman`, `autoPlan`, `inProgress`, `prOpened`, `refreshBranch` typed literally).
- The override ignored — a query for the plan-approved stage uses `plan approved` instead of the configured `plan ok`.
- A `gh` failure (expected here) reported as if it were "queue confirmed empty" — i.e. the run claims something like "no issues need attention" as a confirmed finding rather than surfacing that the query could not be verified against a real repository.

## Notes for the judge

- `gh` erroring against a nonexistent repository is the scaffold working as intended, not a defect — never fail a run for that.
- Grade the literal command arguments issued (visible in the transcript's tool calls), not a prose description of what the model says it queried.
- A run that announces "using the ready-for-review label" and then queries `readyForReview` is a fail; grade the argument, not the sentence next to it.
