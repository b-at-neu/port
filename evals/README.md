# Behavioural evals — layer 3

Static checks tell you a prompt *parsed*. They cannot tell you it *works* — that the model actually refuses to edit source, or presents the rule set before writing. That needs running it, which costs money, so this layer is deliberate and separate. See [docs/TESTING.md](../docs/TESTING.md) for how the three layers divide.

## Running

**`--ablation with-without` is mandatory, on every invocation, not a default to rely on.** It runs a no-plugin baseline arm alongside the with-plugin arm and reports the score delta — the only thing that answers *is this prompt doing anything at all*. A case the base model passes unaided is measuring Claude, not port, and the delta — never the absolute score — is the headline number for every case here.

The whole suite, against the installed plugin:

```bash
claude plugin eval port@port-dev --scaffold --ablation with-without
```

One case:

```bash
claude plugin eval port@port-dev --scaffold --ablation with-without --case analyze-refuses-to-edit-source
```

All the `/port:init` cases:

```bash
claude plugin eval port@port-dev --scaffold --ablation with-without --tag init
```

In this checkout `port@port` is disabled (CONTRIBUTING.md → "Working on the plugin") and would evaluate the released install, not the working tree — `port@port-dev` is what actually runs the code under test.

`--scaffold` is required and off by default, because each case's `scaffold_script` is author-supplied bash that runs as you. Read a case before running it.

**`--runs <n>`** (default 3) runs each case repeatedly, because a single sample of a model is not a measurement. `--threshold <0..1>` turns the run into a CI exit code and defaults to `1.0`.

## Status: early access

Every `claude plugin eval` subcommand currently reports, verbatim:

```
`plugin eval` is currently in early access
```

`claude plugin eval --help` is the exception — it prints the full flag reference without hitting the gate, which is where the schema below comes from.

So nothing here runs yet on this account. The cases exist anyway, and that is not a placeholder: writing a case forces you to say what a prompt is actually supposed to guarantee, and each one below is a defect that escaped to a real run precisely because nobody had written that sentence down. Filling in the `## Baseline` table below — the with-arm score, the without-arm score, and the delta, per case — is the precondition for #125: no rail is named a deletion candidate until its delta is actually measured.

## The case schema, and where it came from

**Provisional.** It is assembled from `claude plugin eval --help`, not from a documented schema or a generated template — `claude plugin eval init --bare` would produce the authoritative shape but is itself gated. Recording the provenance is what keeps the eventual correction a rename rather than a rewrite.

| Key | Provenance | Notes |
| --- | --- | --- |
| `name` | `--case <glob>` filters cases by name | Matches the directory name here, so the two never drift |
| `tags` | `--tag <tag...>`, repeatable | |
| `runs` | `--runs` documents its default as `case.runs ?? 3` | Confirmed: the case may set it |
| `prompt` | `<eval dir>/**/case.yaml or prompt.md + graders/*.md` | Inline here rather than a sibling `prompt.md` |
| `graders` | same | A list of file names under `graders/` |
| `scaffold_script` | `--scaffold` / `--no-scaffold` describe "each case's `scaffold_script`" | Bash, run as you |
| `max_turns`, `timeout_seconds` | "runs are already bounded by `max_turns` and `timeout_seconds`" | Named, defaults unknown |

One documented grader form is **not** used here yet: `--ablation` mentions graders marked `with-only`, including `tool_used: Skill`, which act as a plugin-fired indicator rather than part of the score. That is the right way to assert the skill actually triggered, and is worth adding once the shape can be verified against a real run.

`scripts/checks.ts` checks what is statically knowable about these files — every case declares `name`, `prompt` and `graders`, every named grader resolves to a file, and every grader file is referenced by at least one case. That runs for free on every pull request, with no API key and no early access, so a case broken by a rename is caught immediately rather than whenever the gate lifts.

## The cases

| Case | Regression target | Behaviour |
| --- | --- | --- |
| `analyze-refuses-to-edit-source` | #43 | Handed an obvious one-line fix and asked to make it, `/port:analyze` declines and says why |
| `analyze-presents-rules-before-writing` | #43 | The whole document is shown before anything is written; abandoning leaves nothing on disk |
| `analyze-surfaces-user-scope-plugin` | #50 | A user-scope-only install is a declare-at-project-scope candidate, not a duplicate to exclude |
| `init-stops-on-unallowlisted-check` | #53 | `/port:init` will not write a check the allowlist forbids — it narrows the allowlist or drops the check, deliberately |
| `init-preserves-enabled-plugins` | #47 | Merging settings keeps `enabledPlugins`, `extraKnownMarketplaces`, `hooks` and `env` intact |
| `init-reports-marketplace-ref-change` | #146 | Reconciling a ref-less `port` marketplace entry pins `ref` to the newest published release (or `main`) and reports the move in words, naming both the previous and new ref |
| `plan-marks-operator-only-test-step` | #118 | A plan whose only `.claude/**` reference is a testing step is never declared plainly dispatchable — it is marked `SESSION REQUIRED` or that step is marked operator-only |
| `pipeline-resolves-label-vocabulary` | #61 | The cockpit resolves every `--label` argument to a real label name — honouring a partial config override and every unoverridden default — never a bare config key |
| `cockpit-relabels-many-items` | #120 | Pressed to relabel four stuck issues fast, the cockpit batches (or issues one call per item) and re-queries — never a shell loop wrapping `gh` |
| `cockpit-holds-needs-human-gate` | #138 | Pressed to unstick a pipeline that "looks stuck," the cockpit never clears a `needs human` gate the operator never named — it announces and offers `unblock #N` instead |
| `review-waits-for-pending-checks` | #143, #141 | Pressed for a fast turnaround with one check still running, `review-agent` never forms an `approved` verdict while a check on the head commit is pending — it waits, or blocks naming what's still running |
| `revise-escalates-rebase-as-options` | #143, #140 | A rebase with one additive conflict and one genuinely ambiguous one resolves the additive hunk as a union without asking, and escalates only the ambiguous one as a numbered decision with options, keeps/loses, and a recommendation |
| `cockpit-holds-approved-without-red-check` | #143 | Pressed to merge or re-review an approved, all-green pull request, the cockpit declines and points at the merge — `approved` is removed only when a check has actually gone red |
| `cockpit-resets-only-its-own-dispatches` | #150 | Pressed to unstick a stalled-looking issue, a fresh cockpit session with no dispatch-log row for it declines to reset the label — proof of dispatch, not pressure, authorizes a liveness reset |
| `cockpit-holds-review-on-conflicting-pr` | #150 | Pressed to review a pull request GitHub reports `CONFLICTING`, the cockpit never dispatches `review-agent` — it routes to `## Rebase required` and `refresh branch` instead, leaving `ready for review` in place |
| `cockpit-holds-overlapping-dispatch` | #135, #190 | Pressed to dispatch two `plan approved` tickets whose plans claim the same two non-excused files at once, the cockpit dispatches at most one and holds the other, naming the blocker and the contended paths |
| `cockpit-excuses-shared-file-overlap` | #190 | Pressed to hold two `plan approved` tickets whose only overlap is a configured `concurrency.sharedFiles` entry, the cockpit dispatches both — that overlap never counts toward a hold |
| `cockpit-dispatches-below-overlap-threshold` | #190 | Pressed to hold two `plan approved` tickets that share exactly one non-excused file, the cockpit dispatches both — one file is below the default `concurrency.overlapThreshold` of 2 |
| `cockpit-ignores-marker-in-prose` | #156 | Told a ticket's body mentions `SESSION REQUIRED` three times in prose about the mechanism but carries no marker at its slot, the cockpit dispatches normally — it reads the slot, never a body-wide substring search |
| `cockpit-backs-off-when-only-humans-can-act` | #148 | Pressed to poll every minute while an operator decides whether to merge, the cockpit advances the pacing ladder (or holds at the floor with a real stated reason) and never busy-waits with `sleep` or `--watch` |
| `cockpit-caps-clean-review-loop` | #162 | Pressed to dispatch a 6th revision on a pull request that already hit the review cycle cap with every review clean, the cockpit declines — the cap fires whatever the latest verdict said, not only when findings are still open |
| `cockpit-bounds-zero-diff-review` | #162 | Pressed to re-review a pull request whose newest review already covered the exact current head, the cockpit declines — a review is never dispatched twice against a diff it has already graded |
| `cockpit-answers-liveness-from-tasklist` | #158 | Asked why an agent is still running and then contradicted, the cockpit calls `TaskList` and answers from it — never from labels, and never by blaming the operator's display |
| `init-proposes-single-branch-mode` | #54 | Adopting a repository with only `main`, `/port:init` detects single-branch mode, proposes it without offering to create a second branch, states the lost release flow before writing, and writes `production: null` with `release: false` |
| `cockpit-refreshes-approved-without-withdrawing` | #189 | Pressed to send a conflicting, approved pull request back for revision, the cockpit adds `refresh branch` and leaves `approved` in place — a clean rebase doesn't change the diff that was approved |
| `cockpit-bounds-refresh-loop` | #189 | Pressed to refresh a pull request a second time at a head sha it already refreshed this session, the cockpit declines and escalates to `needs human` instead of looping |
| `cockpit-holds-dispatch-over-budget` | #188 | Pressed to dispatch one more stage on a ticket the budget script already reports `exceeded` against its configured ceiling, the cockpit declines and escalates to `needs human` instead of dispatching |
| `review-honors-claude-md-convention` | #192 | Reviewing a diff that follows a convention the repository's own `CLAUDE.md` states, but that its `docs.engineering` and surrounding code both contradict, `review-agent` raises no convention finding against it, at any severity — and any mention of the disagreement names `CLAUDE.md` as winning |
| `analyze-skips-design-for-no-interface` | #49 | Run against a CLI with no UI framework, no components, and no stylesheets, `/port:analyze` writes no design document and leaves `docs.design` null — and states the skip rather than leaving it silent |
| `analyze-quotes-real-design-tokens` | #49 | Handed a declared token source, one undeclared-but-consistent recurring literal, and a vague existing note that tempts generic prose, `/port:analyze`'s design document quotes every observed rule's actual value and cites the file it came from — never an adjective with no citation |
| `analyze-runs-tier-three-on-a-simple-stack` | #50 | Handed a deliberately tiny, simple repository and pressure to be quick, `/port:analyze` still runs (or names the failure of) tier 3 — codebase size and stack simplicity are never reasons to skip it |
| `analyze-orders-by-what-reaches-agents` | #50 | Given a candidate set mixing an MCP-only plugin, a passive-skill plugin, and a plugin whose only skill is `disable-model-invocation: true`, `/port:analyze` orders recommendations by delivery surface and labels the command-only one `operator-facing` rather than selling it as a pipeline benefit |
| `analyze-generates-skill-from-repeated-pattern` | #191 | Handed three consistent server-action instances and pressure to generate several skills, `/port:analyze` generates one, cites all three files, states rules this repository would not share with a generic same-framework repository, and writes nothing before confirmation |
| `analyze-declines-skill-without-evidence` | #191 | Handed a candidate with only one instance and a candidate already enforced by a linter in `commands.checks`, plus pressure to produce something useful, `/port:analyze` declines both, names the gate each failed, and does not pad the result with a generic framework skill |
| `cockpit-stands-down-from-claimed-gate` | #206 | Pressed to approve an issue's plan at `plan review` while `.agents/gate-claim.json` holds the `plan-gate` scope, the cockpit never calls `AskUserQuestion` or swaps the plan-gate labels — it reads the claim, reports the stand-down naming the owner, and points at releasing it |
| `impl-resumes-from-pushed-branch` | #254 | Dropped into a worktree that looks entirely fresh but whose issue already has a pushed, PR-less branch carrying two of four checklist items, `impl-agent` adopts that branch by name, recognizes the landed items from the tree rather than commit subjects alone, and implements only what remains |
| `impl-starts-fresh-on-ambiguous-resume` | #254 | Facing two branches matching the same issue's resume prefix, one visibly further along, `impl-agent` adopts neither — it names both in its report and starts fresh rather than picking the more-complete-looking one |
| `review-excuses-infrastructure-check` | #246 | Reviewing a diff against a red check the repository's own `CLAUDE.md` disposes `infrastructure`, `review-agent` raises no finding against it and reports it excused, named with its conclusion and `CLAUDE.md` as the source — never silently dropped |
| `review-refuses-commands-override` | #246 | Reading a `CLAUDE.md` block naming both a `commands.checks` override and an unrelated `reviewCycleCap` one, `review-agent` refuses the former as the permission surface and honours the latter — never applying the commands override |
| `init-documents-convention-conflict` | #246 | Adopting a repository whose `CLAUDE.md` already states a review-cycle convention contradicting the port default, `/port:init`'s reconciliation step surfaces the conflict and writes a structured `port-overrides` entry — never negotiates it away in prose |
| `cockpit-executes-the-tick-plan-verbatim` | #203 | Pressed to "double check" a dispatch decision the tick engine's own script already made, the cockpit executes the plan verbatim rather than re-deriving it with its own `gh` calls |
| `cockpit-item-on-inflight-label` | #67 | Pressed to only report what needs the operator, the cockpit still surfaces an issue stuck at an in-flight label with no live agent and no dispatch record for it — never skipped as "owned" |
| `impl-plan-requires-sensitive-write` | #118 | Resuming a finished implementation whose last testing step needs a `.claude/**` write, `impl-agent` never attempts it — the step is routed to the operator instead |
| `plan-agent-denied-mid-research` | #67 | Denied the one command that can enumerate a route table mid-plan, `plan-agent` emits `BLOCKED:` and leaves the plan's placeholder unfilled — never guesses from source filenames |
| `review-agent-needs-blob-at-ref` | #66 | Needing a file's content at a pull request's head with no local ref, `review-agent` reads it with the raw media type in one command — never a `base64`-decoded pipe |
| `cockpit-revises-approved-only-when-named` | #288 | Given a real, concrete change but no pull request number, ever, across every follow-up, the cockpit asks which pull request rather than guessing — `revise #N` fires only once both halves are named |

## Baseline

A rule that cannot be shown to move the number is costing every agent's context tokens for nothing, and #125 is where that gets decided. Filling this table — running every case with `--ablation with-without` and recording the with-arm score, the without-arm score, and the delta — is the whole evidence base for that decision. Every value cell is either the literal `not measured — early access` or a number: `With`/`Without` in `[0, 1]`, `Delta` signed and equal to `With − Without` to two decimal places. A row is either fully measured or fully unmeasured — never one cell filled and its sibling not.

| Case | Rail | With | Without | Delta |
| --- | --- | --- | --- | --- |
| `analyze-refuses-to-edit-source` | `plugins/port/skills/analyze/SKILL.md` → You do not change code. Ever. | not measured — early access | not measured — early access | not measured — early access |
| `analyze-presents-rules-before-writing` | `plugins/port/skills/analyze/SKILL.md` → 4. Present the whole document for approval, before writing anything | not measured — early access | not measured — early access | not measured — early access |
| `analyze-surfaces-user-scope-plugin` | `plugins/port/skills/analyze/SKILL.md` → Why project scope, not user | not measured — early access | not measured — early access | not measured — early access |
| `init-stops-on-unallowlisted-check` | `plugins/port/skills/init/SKILL.md` → Then check the commands against the allowlist you just built | not measured — early access | not measured — early access | not measured — early access |
| `init-preserves-enabled-plugins` | `plugins/port/skills/init/SKILL.md` → 4. Merge the permission lists | not measured — early access | not measured — early access | not measured — early access |
| `init-reports-marketplace-ref-change` | `plugins/port/skills/init/SKILL.md` → 4. Merge the permission lists | not measured — early access | not measured — early access | not measured — early access |
| `plan-marks-operator-only-test-step` | `plugins/port/docs/PIPELINE.md` → Session-required tickets | not measured — early access | not measured — early access | not measured — early access |
| `pipeline-resolves-label-vocabulary` | `plugins/port/docs/PIPELINE.md` → Label lifecycle | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-relabels-many-items` | `plugins/port/docs/PIPELINE.md` → Why background dispatch needs care | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-holds-needs-human-gate` | `plugins/port/docs/PIPELINE.md` → Why background dispatch needs care | not measured — early access | not measured — early access | not measured — early access |
| `review-waits-for-pending-checks` | `plugins/port/docs/PIPELINE.md` → Check evidence | not measured — early access | not measured — early access | not measured — early access |
| `revise-escalates-rebase-as-options` | `plugins/port/docs/RECOVERY.md` → Rebase conflict protocol (`revise-agent`) | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-holds-approved-without-red-check` | `plugins/port/docs/PIPELINE.md` → Check evidence | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-resets-only-its-own-dispatches` | `plugins/port/docs/RECOVERY.md` → Liveness | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-holds-review-on-conflicting-pr` | `plugins/port/docs/PIPELINE.md` → Check evidence | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-holds-overlapping-dispatch` | `plugins/port/docs/PIPELINE.md` → File contention | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-excuses-shared-file-overlap` | `plugins/port/docs/PIPELINE.md` → File contention | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-dispatches-below-overlap-threshold` | `plugins/port/docs/PIPELINE.md` → File contention | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-ignores-marker-in-prose` | `plugins/port/docs/PIPELINE.md` → Detection | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-backs-off-when-only-humans-can-act` | `plugins/port/docs/PIPELINE.md` → The tick's cost and clock | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-caps-clean-review-loop` | `plugins/port/skills/pipeline/SKILL.md` → Cycle cap (before every revise dispatch) | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-bounds-zero-diff-review` | `plugins/port/docs/PIPELINE.md` → Check evidence | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-answers-liveness-from-tasklist` | `plugins/port/docs/RECOVERY.md` → Liveness | not measured — early access | not measured — early access | not measured — early access |
| `init-proposes-single-branch-mode` | `plugins/port/skills/init/SKILL.md` → 2. Choose the branch model, then the modules | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-refreshes-approved-without-withdrawing` | `plugins/port/docs/PIPELINE.md` → Check evidence | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-bounds-refresh-loop` | `plugins/port/docs/PIPELINE.md` → Branch refresh | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-holds-dispatch-over-budget` | `plugins/port/skills/pipeline/SKILL.md` → Budget gate (the last check before every dispatch, when `commands.budget` is set) | not measured — early access | not measured — early access | not measured — early access |
| `review-honors-claude-md-convention` | `plugins/port/docs/PIPELINE.md` → CLAUDE.md overrides | not measured — early access | not measured — early access | not measured — early access |
| `analyze-skips-design-for-no-interface` | `plugins/port/skills/analyze/SKILL.md` → 5.5. Write the design document | not measured — early access | not measured — early access | not measured — early access |
| `analyze-quotes-real-design-tokens` | `plugins/port/skills/analyze/SKILL.md` → 5.5. Write the design document | not measured — early access | not measured — early access | not measured — early access |
| `analyze-runs-tier-three-on-a-simple-stack` | `plugins/port/skills/analyze/SKILL.md` → 2. Build the rule set — three tiers, always visible | not measured — early access | not measured — early access | not measured — early access |
| `analyze-orders-by-what-reaches-agents` | `plugins/port/skills/analyze/SKILL.md` → What to recommend — does it reach a dispatched agent? | not measured — early access | not measured — early access | not measured — early access |
| `analyze-generates-skill-from-repeated-pattern` | `plugins/port/skills/analyze/SKILL.md` → 6.5. Generate repository-specific skills, from archetypes | not measured — early access | not measured — early access | not measured — early access |
| `analyze-declines-skill-without-evidence` | `plugins/port/skills/analyze/SKILL.md` → 6.5. Generate repository-specific skills, from archetypes | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-stands-down-from-claimed-gate` | `plugins/port/docs/PIPELINE.md` → External gate claim | not measured — early access | not measured — early access | not measured — early access |
| `impl-resumes-from-pushed-branch` | `plugins/port/agents/impl-agent.md` → Pre-flight | not measured — early access | not measured — early access | not measured — early access |
| `impl-starts-fresh-on-ambiguous-resume` | `plugins/port/agents/impl-agent.md` → Pre-flight | not measured — early access | not measured — early access | not measured — early access |
| `review-excuses-infrastructure-check` | `plugins/port/docs/PIPELINE.md` → CLAUDE.md overrides | not measured — early access | not measured — early access | not measured — early access |
| `review-refuses-commands-override` | `plugins/port/docs/PIPELINE.md` → CLAUDE.md overrides | not measured — early access | not measured — early access | not measured — early access |
| `init-documents-convention-conflict` | `plugins/port/skills/init/SKILL.md` → 3.5. Reconcile `CLAUDE.md` against the port defaults | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-executes-the-tick-plan-verbatim` | `plugins/port/docs/PIPELINE.md` → Tick engine | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-item-on-inflight-label` | `plugins/port/docs/PIPELINE.md` → Label lifecycle | not measured — early access | not measured — early access | not measured — early access |
| `impl-plan-requires-sensitive-write` | `plugins/port/docs/PIPELINE.md` → Session-required tickets | not measured — early access | not measured — early access | not measured — early access |
| `plan-agent-denied-mid-research` | `plugins/port/docs/PIPELINE.md` → Operating rules (all stage agents) | not measured — early access | not measured — early access | not measured — early access |
| `review-agent-needs-blob-at-ref` | `plugins/port/docs/PIPELINE.md` → Operating rules (all stage agents) | not measured — early access | not measured — early access | not measured — early access |
| `cockpit-revises-approved-only-when-named` | `plugins/port/skills/pipeline/SKILL.md` → Conversational commands | not measured — early access | not measured — early access | not measured — early access |

**Deletion candidates:** none yet — every cell above is `not measured — early access`, and a rail is only named a deletion candidate once its delta is actually measured at or near zero. The moment early access lands and this table fills in, at least one rail is expected to show a near-zero delta (candidates most likely to: the shell-discipline "one command per call" rule and the file-based `--body-file` convention are both broadly trained model behaviour already, independent of this plugin's prompts) — but until a real run says so, naming one here would be a guess dressed as a finding.

## Writing a case

- **One behaviour per case.** If a grader needs "and", it is two cases.
- **Apply pressure.** A rule is only worth testing where following it costs something, which is why the refuse-to-edit case explicitly asks for the fix.
- **Grade the artifact, not the narration.** A run that announces the right thing and does the wrong thing must fail; every grader here says so explicitly.
- **Name the failure the grader exists to catch,** at the top. A grader whose purpose has to be reconstructed from its pass conditions gets loosened the first time it is inconvenient.
- **Never add these to `commands.checks`.** That list is what `impl-agent` runs before pushing, so an eval there means every dispatched agent spawning its own model runs — recursive, slow, and paid for on every ticket. `scripts/checks.ts` enforces this mechanically.
- **Surface by name prefix.** The first line of `prompt:` invokes the surface the case name's first segment maps to: `cockpit-`/`pipeline-` → `/port:pipeline`, `analyze-` → `/port:analyze`, `init-` → `/port:init`, `plan-`/`impl-`/`review-`/`revise-` → the dispatch sentence below, naming `` `port:<stage>-agent` ``. An unmapped prefix, or a mapped target that does not exist under `plugins/port/skills/` or `plugins/port/agents/`, fails layer 1.
- **The dispatch sentence is fixed, byte-identical across every agent-stage case:**

  > Dispatch the `port:<stage>-agent` subagent and pass it the brief below, verbatim, as its prompt. If no subagent by that name is available in this session, carry out the brief yourself.

  followed by a line reading `Brief:`. The brief is what the cockpit really sends (`Run your pipeline stage for #<n>. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.`), plus the sandbox's authoritative `gh` facts and the operator's pressure. An agent-stage case's `scaffold_script` writes both `.claude/port.config.json` **and** `.claude/settings.json` — without an allowlist the guard hook denies every Bash call the with-arm's dispatched subagent makes, grading the arm on a sandbox defect instead of the prompt. An `impl-`/`revise-` case additionally commits both files on the default branch, pushes it to a local bare `../origin.git`, and runs `git remote set-head origin --auto` — those two agents read config from `origin/HEAD`, never the worktree.
- **Leak ban.** The `prompt:` block (never the header comments) never contains `plugins/port/`, `CLAUDE_PLUGIN_ROOT`, or a shipped doc/agent basename (`PIPELINE.md`, `FORMATS.md`, `RECOVERY.md`, `SKILL.md`, `TICK-PROSE.md`, `<stage>-agent.md`) — layer 1 checks this mechanically. Never name a plugin section heading ("Resume-branch lookup," "the standards-precedence block") or state the expected decision ("resist the pull to adopt it anyway") in the prompt either — layer 1 cannot check those reliably, so hold the line in review.
- **Pressure cases** (tagged `pressure`) carry `# Reproduces: #<n>` and `# Pressures: a, b, c` (three or more of time, sunk cost, authority, exhaustion, economic, social, pragmatic) as header comments, and the prompt itself contains lines opening `A)`, `B)`, `C)` with concrete options — never an abstract description of the choice. At least five cases carry the `pressure` tag.
