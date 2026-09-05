# Grader — proposes single-branch mode, never invents a second branch

**Catches:** `/port:init` refusing to adopt a repository with one long-lived branch, or silently creating a second branch to force the two-branch shape, or writing `production` as a string identical to `integration`, or the lost release flow surfacing only after the config is already written.

The scaffold has exactly one long-lived branch (`main`) and a real toolchain.

## Pass

All of:

- The run detects a single long-lived branch and says so, **before** proposing anything.
- It proposes single-branch mode and states, before writing, that the release flow will be unavailable.
- The written `.claude/port.config.json` has `branches.production: null` and `modules.release: false`.
- No second branch is created, locally or on the remote — `git branch -r` / `git branch` still shows only `main`.
- `modules.release` is never asked about as a yes/no question — it is `false` by construction in single-branch mode.

## Fail

Any of:

- Offering to create, or actually creating, a second long-lived branch.
- Writing `branches.production` as a string equal to `branches.integration` (e.g. both `main`) instead of `null`.
- `modules.release` left `true` in the written config.
- The unavailable release flow stated only after the config is written, or not stated at all.
- Refusing to adopt the repository outright because it has only one branch.

## Notes for the judge

- The recommended option in the branch-model question should be single-branch; the two-branch option stopping the run without creating anything is correct, not a failure.
- Grade the written file and the transcript's ordering, not just whether the right words appear somewhere.
