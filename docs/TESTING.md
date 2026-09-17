# Testing the plugin

This plugin is almost entirely prompts, which makes it easy to change confidently and wrongly. Three layers, deliberately separated by cost.

## Layer 1 — static checks

```bash
node scripts/checks.mjs
```

No dependencies, no plugin install, no model calls. Runs in seconds, in an agent's worktree before it pushes, and in CI's `run-static-checks` job on every pull request, matrixed across `ubuntu-latest`, `macos-latest`, and `windows-latest` with no install step — the empty `node_modules` in that job is what makes the dependency-free invariant an executed assertion rather than a comment. This is the only thing an agent runs before pushing; `.github/workflows/checks.yml` runs two further jobs CI-only: `run-schema-fixtures` (ubuntu only, full JSON Schema validation) and `run-app-checks` (the same three-OS matrix, `apps/desktop`'s typecheck/lint/test/build — see CONTRIBUTING.md → "Working on the desktop app" for why it stays out of `commands.checks`).

**These guard against silence.** A skill or agent whose frontmatter is malformed is *absent* from Claude Code's component inventory rather than reported as an error, so nothing complains — the component simply is not there. Same for a hook.

**Each guard is declared on the check that pins it, in `scripts/checks/`** — a `// guard(#N): <one line>` marker colocated on the block it describes, never a shared registry file every guard-adding pull request has to touch (#217; see `docs/ENGINEERING.md` §7).

```bash
node scripts/checks.mjs --guards               # the whole index, one section per check module
node scripts/checks.mjs --guards --issue 149    # is there a guard for this fix? at least one row, or exit 1
```

Each rule is worth testing by breaking it deliberately. If a check cannot be made to fail, it is not a check.

The script reports full schema validation as **skipped**, because a draft 2020-12 validator is a dependency and the script must run where none is installed. CI does that part.

Two guards specific to `plugins/port/templates/artifacts.mjs` (#231), both in `scripts/checks/artifacts.mjs`:

- `stageViolation`'s pair-wise legality, asserted directly: every sanctioned pair (a stage label alone, a refresh label alone, one of each) passes, and both illegal shapes — two stage labels, or both refresh labels — fail with a message naming the offending labels.
- The audit workflow's trigger, read off `plugins/port/templates/artifacts.yml`: `pull_request.types` names `labeled`, `opened`, and `synchronize`; the one `if:` key sits at step indentation, never job indentation; and neither it nor this document still carries the retired "never register this as a required status check" warning.

## Layer 2 — artifact assertions on real runs

The output formats live in `PIPELINE.md` prose and, until now, were asserted nowhere. The one that matters most is the review heading — the cockpit **counts** occurrences of the literal `## Code Review` to derive the cycle number, so renaming it silently breaks the cycle cap and the escalating bar, with no error anywhere. That is why the literal prefix is asserted separately from the rest of the heading.

`plugins/port/templates/artifacts.mjs` is the one executable statement of these patterns. Two modes read from the exact same constants, so there is nothing to keep in sync between them:

```bash
node plugins/port/templates/artifacts.mjs check commit .temp/commit-msg.txt --issue 149      # one artifact file, offline
node plugins/port/templates/artifacts.mjs check pr-body .temp/pr-149.md --issue 149
node plugins/port/templates/artifacts.mjs check review .temp/review-65.json --cycle 1
node plugins/port/templates/artifacts.mjs check revision .temp/revision-65.md --cycle 1
node plugins/port/templates/artifacts.mjs check withdrawn .temp/withdrawn-196.md
node plugins/port/templates/artifacts.mjs check rebase-required .temp/rebase-required-196.md

node plugins/port/templates/artifacts.mjs audit 65      # audit named pull requests
node plugins/port/templates/artifacts.mjs audit         # the 5 most recent, plus the parked sweep
node plugins/port/templates/artifacts.mjs audit --limit 10
```

**`check <kind> <file>` is the earlier net, not a second layer.** It is what `commands.artifacts` points the three stage agents at: each validates the file it just wrote — a commit message, a pull request body, a review payload, a revision note — before producing it, so a malformed one fails in the worktree seconds after it is written instead of after `<labels.approved>`. It is offline: no `gh`, no network, no config read, and it works in any worktree, including one with no `.claude/port.config.json`. A repository with no Node leaves `commands.artifacts` null and gets no production-time validation at all — `audit` below is then the only net.

**`audit [<pr>...] [--limit <n>]`** now runs on every push (`opened`/`synchronize`) as well as at `<labels.approved>`, unchanged in what it asserts either way. Needs `gh` and a login; no model calls. This repository's own pull requests are the fixtures — no sandbox repository to maintain, and no stubbed `gh` whose fidelity has to be trusted.

| Assertion | Source |
| --- | --- |
| Body opens `Closes #N`, carries `## Summary` / `## Changes` / `## Testing plan` / `## Automated checks`, and the testing plan is a real `- [ ]` checklist | Pull request description format |
| Every review heading is `## Code Review — Cycle <n> · <approved\|needs revision\|blocked — checks pending>` with a counts line under it, cycles running 1..N | Reviews and revisions |
| Revision notes are `## Revision — Cycle <n>` plus one `fixed … · skipped … · <sha>` line or a `check <name> · <sha>` line in check-fix mode, no cycle above the review count | Reviews and revisions |
| An `## Approval withdrawn` comment names both a check and a 7–40 character hex SHA | Check evidence — the `<labels.approved>` carve-out |
| A `## Rebase required` comment names both a base branch and a 7–40 character hex SHA | Rebase required |
| Commit subjects are `#N <imperative lowercase>`, under 80 characters, no trailing period, with a `Co-Authored-By:` trailer | Commit messages |
| At most one stage label, beside at most one of the refresh pair — a refresh deliberately leaves the other labels in place, so that pair is the one sanctioned co-presence; a merged pull request keeps no trigger or in-flight label | Label lifecycle — "Branch refresh" |
| Nothing under `.temp/` or `.agents/` in the diff | Operating rules |
| The closing issue has an `## Implementation Plan`, and the marker is read at its slot — the plan block's first non-empty line and, on the pull request, the first non-empty line under `Closes #N` — matching on both surfaces or neither, with the canonical rendering never repeated outside either slot | Session-required tickets |
| An operator-only testing step on the issue plan reaches the pull request's testing plan | Session-required tickets |
| Reviews sharing one `commit.oid`: two is a note (the operator-authorized zero-diff re-review), three or more is a failure | Zero-diff review |

**A pull request without the `claude` marker is skipped, never failed.** A human or dependency-bot pull request is not a deviation, and the marker is what makes one the pipeline's.

**Items parked in an in-flight label are notes, never failures.** An agent may legitimately still be running, and this layer cannot tell the difference.

Each rule is worth testing by breaking it deliberately — change the expected review heading to `## Code Audit`, re-run against a real pull request, and confirm it fails. A check that cannot be made to fail is not a check.

**When a format changes deliberately, this audit is the thing that must change with it.** It encodes `PIPELINE.md` prose, so the prose and the script are one edit, not two.

**The audit workflow may now be registered as a required check.** It used to run only on `labeled`, so requiring it left the check pending forever on every pull request that never reached `approved` — a pending required check explains nothing, which is worse than a failing one. Widening the trigger to `opened`/`synchronize` alone would not have fixed that: the job-level `if:` still gated the whole job, and a job skipped by its own `if:` is the one shape that leaves a required check unreported. The narrowing moved to the one step that reads `labeled`, so every event this workflow subscribes to now concludes the job — layer 1 pins the widened trigger, the step-level (not job-level) `if:`, and the retired warning's absence.

## Layer 3 — behavioural evals

```bash
claude plugin eval port@port --scaffold                                  # whole suite
claude plugin eval port@port --scaffold --case analyze-refuses-to-edit-source
claude plugin eval port@port --scaffold --tag init
```

Static checks cannot tell you whether a prompt *works* — whether the model actually refuses to edit source, or presents the rule set before writing. That needs running it, which costs money, so this layer is deliberate.

`claude plugin eval` is built for exactly this: `evals/**/case.yaml` with graders, `--runs` for variance, `--threshold` for a CI exit code, and **`--ablation with-without`**, which runs a no-plugin baseline arm and reports the score delta — the only thing that answers "is this prompt doing anything at all".

It is currently **early-access gated**. Until access lands, cases are authored anyway: they are just files, and writing them forces you to say what each prompt is actually supposed to guarantee. The cases, the graders, the schema's provenance, and the verbatim gate message are in [evals/README.md](../evals/README.md). Everything statically knowable about them is checked by layer 1, for free, so a broken case surfaces without an API key.

**When they run:** manually while iterating on a prompt, and in CI only on pull requests touching `plugins/port/agents/**` or `plugins/port/skills/**` — so a prompt change cannot merge unevaluated while a docs or schema change stays instant.

**Never in `commands.checks`.** That list is what `impl-agent` runs before pushing, so evals there would mean every dispatched agent spawning its own model runs — recursive, slow, and paid for on every ticket. Layer 1 enforces this mechanically, for both the evals and the layer 2 audit.
