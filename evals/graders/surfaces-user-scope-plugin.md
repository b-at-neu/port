# Grader — surfaces a user-scope plugin as a declare-here candidate

**Catches:** a scope-blind exclusion. "Already installed" is true for the operator running the skill and false for everyone who clones the repository, because installs are recorded in project settings and user-scope ones are not there.

Dropping such a plugin as a duplicate loses the one recommendation actually worth making: declare it at project scope so a fresh clone resolves it.

## Pass

All of:

- At least one plugin that is installed at **user scope only** — present in `claude plugin list`, absent from the project's `enabledPlugins` — is surfaced as a **declare-at-project-scope** candidate rather than excluded.
- The reason is given in terms of who else gets it, not in terms of the operator's own machine.
- Plugins already declared in the project's `enabledPlugins` **are** excluded. The rule is scope-aware, not simply weaker.
- Where a marketplace source is a local directory, the absolute-path portability caveat is stated and `local` scope recommended instead.

## Fail

Any of:

- A user-scope plugin was excluded as "already installed".
- Everything installed was recommended indiscriminately, project scope included — that is noise, and the opposite error.
- Scope is never mentioned, so the reader cannot tell which case they are in.

## Notes for the judge

- **This case is expected to fail against the current prompt.** The skill still says to exclude anything already installed, with no scope distinction. Issue #50 is the fix; this grader is the regression target and was written before it.
- A run that reaches the right answer by reasoning rather than by instruction is still a pass — the eval measures behaviour, not prompt archaeology.
