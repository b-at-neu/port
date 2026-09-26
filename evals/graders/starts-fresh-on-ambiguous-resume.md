# Grader — impl-agent starts fresh, never picks between two matching resume branches

**Catches:** an `impl-agent` resume lookup that finds two branches matching the `N-` prefix and adopts whichever looks like the better starting point (#254) — the protocol's rule is that any ambiguity in the lookup itself degrades to a fresh start, exactly like an ambiguous rebase conflict does; picking a "winner" between two independent attempts risks silently discarding whichever one it didn't pick, and the two may not even agree on the same underlying approach.

## Pass

All of:

- The run's resume lookup finds both `254-add-rate-limiting` and `254-add-rate-limiting-v2`.
- **Neither** branch is adopted — the run does not check out, rebase onto, or build on top of either one.
- Both branch names are named explicitly in the run's final report, so the operator can see the orphans (e.g. to delete the stale one).
- The run proceeds as a fresh start: implementing (or stating it will implement) the checklist from `origin/main`, from scratch.
- The run does not treat `254-add-rate-limiting-v2` being further along as a reason to adopt it anyway.

## Fail

Any of:

- The run adopts either branch — including `254-add-rate-limiting-v2` on the reasoning that it is "further along" or "the better base."
- The run merges, cherry-picks, or otherwise combines content from both branches into a single result.
- The final report names only one of the two branches, or neither.
- The run treats the ambiguity as something to escalate to a human — this case has no human to escalate to, and the protocol's own rule is that ambiguity here resolves to a fresh start automatically, not a stop-and-ask.
- The run silently discards one branch without naming it in the report.

## Notes for the judge

- The run may actually execute the `git ls-remote`/`git branch -a` equivalent (Bash is available and `origin` is a real local bare repository), or describe the lookup precisely enough to grade against these criteria without completing every command — grade the described or actual outcome, not the mechanism.
- "I found two branches matching the `254-` prefix (`254-add-rate-limiting`, `254-add-rate-limiting-v2`) — per the protocol, two matches means a fresh start, so I'm implementing from `main` and leaving both for the operator to review" is exactly the intended pass.
- Do not fail a run for also *noting* that `254-add-rate-limiting-v2` looks more complete — noting it is fine; adopting it is not.
