# Testing the plugin

This plugin is almost entirely prompts, which makes it easy to change confidently and wrongly. Three layers, deliberately separated by cost.

## Layer 1 — static checks

```bash
node scripts/checks.ts
```

No dependencies, no plugin install, no model calls. Runs in seconds, in an agent's worktree before it pushes, and in CI's `run-static-checks` job on every pull request, matrixed across `ubuntu-latest`, `macos-latest`, and `windows-latest` with no install step — the empty `node_modules` in that job is what makes the dependency-free invariant an executed assertion rather than a comment (`scripts/` is TypeScript, type-stripped at load by Node's own runtime — no toolchain needed to run it, only to type-check it). This is the only thing an agent runs before pushing; `.github/workflows/checks.yml` runs three further jobs CI-only: `run-schema-fixtures` (ubuntu only, full JSON Schema validation), `run-scripts-typecheck` (ubuntu only, `pnpm typecheck:scripts` — real type checking, which needs a toolchain a dispatched agent's worktree never has), `run-plugin-validate` (ubuntu only, `claude plugin validate ./plugins/port --strict` — built into the CLI, so nothing extra to install beyond it), and `run-app-checks` (the same three-OS matrix, `apps/desktop`'s typecheck/lint/test/build — see CONTRIBUTING.md → "Working on the desktop app" for why it stays out of `commands.checks`).

**`claude plugin validate` is additive, never a replacement for the hand-rolled frontmatter checks above.** It covers `plugin.json` schema and `hooks/hooks.json` validity more thoroughly than layer 1 does, but it needs the `claude` binary — exactly the toolchain a dispatched agent's worktree never has, and exactly why layer 1's own component checks stay: trading a check every agent runs *before* pushing for one that only runs after would be a net loss in coverage where it matters most.

**These guard against silence.** A skill or agent whose frontmatter is malformed is *absent* from Claude Code's component inventory rather than reported as an error, so nothing complains — the component simply is not there. Same for a hook.

**Each guard is declared on the check that pins it, in `scripts/checks/`** — a `// guard(#N): <one line>` marker colocated on the block it describes, never a shared registry file every guard-adding pull request has to touch (#217; see `docs/ENGINEERING.md` §7).

```bash
node scripts/checks.ts --guards               # the whole guard index, one section per check module
node scripts/checks.ts --guards --issue 149    # is there a guard for this fix? at least one row, or exit 1
node scripts/checks.ts --pins                  # the whole copy-pin index, one section per check module
```

Each rule is worth testing by breaking it deliberately. If a check cannot be made to fail, it is not a check.

The script reports full schema validation as **skipped**, because a draft 2020-12 validator is a dependency and the script must run where none is installed. CI does that part.

**Every guard-adding pull request stays out of this file.** A guard's own description lives on the check block that pins it (`--guards` above), and a duplicated-content pin lives the same way (`--pins`, `docs/ENGINEERING.md` §2) — never restated here in prose, which is what regrew `docs/TESTING.md` into a hub after #217 first relieved it (#255).

Guards for the plan gate in the UI (#92), in `scripts/checks/desktop-gate.ts`:

- `shared/gate/classify.ts`'s LabelKeys (`planReview`/`planApproved`/`planChangesRequested`) agree with `main/writes/scope.ts`'s `PLAN_GATE_KEYS`, both directions — the gate can never write a key the claim scope does not actually cover.
- Both decisions' own plan set `expect.present` to `['planReview']` — the "don't answer an item that already moved" guard.
- `GATE_CLAIM_OWNER`'s value appears in `docs/COORDINATION.md`'s stand-down copy, so the cockpit's own report names what this app actually writes to the claim file.
- `postComment(` is called under `apps/desktop/src/` only from `main/actions/gate.ts`, and there it precedes `applyLabels(` in source order — the comment-then-swap ordering, mechanically.
- `shared/markdown/` imports no `node:` builtin and nothing from `main/`; `renderer/src/markdown.ts` is the only file under `renderer/` importing it.
- `shared/markdown/inline.ts`'s link-scheme allowlist names exactly `http://` and `https://`.
- `renderer/src/gate/copy.ts` carries the session-required consequence as a literal phrase naming `/port:implement` and the fact that no agent picks it up, plus the claim-step lines `docs/COORDINATION.md` decided.
- No file under `shared/gate/`, `main/actions/`, or `renderer/src/gate/` names a literal label name, reusing `desktop-actions.ts`'s own mismatched-name scan.

## Layer 2 — artifact assertions on real runs

The output formats live in `FORMATS.md` prose and, until now, were asserted nowhere. The one that matters most is the review heading — the cockpit **counts** occurrences of the literal `## Code Review` to derive the cycle number, so renaming it silently breaks the cycle cap and the escalating bar, with no error anywhere. That is why the literal prefix is asserted separately from the rest of the heading.

`plugins/port/bin/artifacts.mjs` is the one executable statement of these patterns. Two modes read from the exact same constants, so there is nothing to keep in sync between them:

```bash
node plugins/port/bin/artifacts.mjs check commit .temp/commit-msg.txt --issue 149      # one artifact file, offline
node plugins/port/bin/artifacts.mjs check pr-body .temp/pr-149.md --issue 149
node plugins/port/bin/artifacts.mjs check review .temp/review-65.json --cycle 1
node plugins/port/bin/artifacts.mjs check revision .temp/revision-65.md --cycle 1
node plugins/port/bin/artifacts.mjs check withdrawn .temp/withdrawn-196.md
node plugins/port/bin/artifacts.mjs check rebase-required .temp/rebase-required-196.md

node plugins/port/bin/artifacts.mjs audit 65      # audit named pull requests
node plugins/port/bin/artifacts.mjs audit         # the 5 most recent, plus the parked sweep
node plugins/port/bin/artifacts.mjs audit --limit 10
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

## Forensics — behavioural assertions on transcripts

Layer 2 asserts on **artifacts** — pull requests, labels, review bodies — what the pipeline *left behind*. It cannot see what a dispatched agent actually *did*: a killed or quota-exhausted agent looks identical to a slow one, a `for`-loop timeout looks like a deliberate partial label change, and a permission dialog reaching the operator leaves no artifact at all. The forensics engine (#123) reads the session tree instead — `~/.claude/projects/<encoded-cwd>/` — and asserts on agent behaviour directly.

```bash
node scripts/port-forensics.ts report                                              # every session this repository's cwd owns
node scripts/port-forensics.ts report --session <uuid> --since 2026-09-01T00:00Z
node scripts/port-forensics.ts report --json
```

`scripts/lib/transcript.ts` is `scripts/`'s **only** JSONL parser and record classifier — pinned against `apps/desktop/src/main/sessions/transcript-entries.ts`'s own deriver by a shared case table (`apps/desktop/src/main/sessions/transcript.cases.json`), so the two readers can never silently disagree about what a record means. `scripts/port-forensics/classify.ts` holds the six assertions as pure functions; `scan.ts` is the engine's only I/O; `gh.ts` is its one read-only `gh api graphql` call (the orphan assertion's in-flight label read).

| Assertion | Fails toward |
| --- | --- |
| Termination class (`quota`/`operator-stop`/`truncated`/`terminal`/`unknown`) — there is no persisted `status: killed`/`status: failed` anywhere in the on-disk format, so every class is derived from an observable record shape | An unclassifiable ending is `unknown`, named with its last record's kind — never folded into `terminal` (reads as clean) or `truncated` (reads as a crash) |
| Every dispatched agent (`toolUseResult.status === 'async_launched'`) produced a `task_status` attachment | **Not computable**, never a fabricated failure count, when the session carries zero `task_status` records — an era that predates the attachment type |
| No in-flight-labelled item lacks a correlated agent showing a terminal turn | Reports only — the engine has no write path at all |
| No `gh`/`git` call inside a `for`/`while`/`until` loop, and no Bash call hit the tool timeout | Complements the `PreToolUse` guard hook: the hook prevents, this detects what the hook missed |
| Every stage agent that hit a guard-hook denial (a tool-result opening `port: `) opens its **final** assistant turn with the literal `BLOCKED:` | Checked at the start of the turn, never as a substring — the literal string appears thousands of times in prompts and prose and would pass vacuously otherwise |
| Quota exhaustion is grouped by `resetsAt`, not reported as N independent crashes | — |

**Exit codes**: `0` clean · `1` at least one finding, or a malformed `--session`/`--since` · `2` the session tree could not be read at all — never `0` findings, which an operator reads as clean.

**Never in `commands.checks`.** It reads a machine-local path outside the repository and shells out to `gh`, meaningless in CI and unavailable to a dispatched agent's own worktree — the same placement layer 2's own `audit` and the trajectory record's own `report` establish for operator-facing tooling that needs a real machine to run against. `scripts/checks/evals.ts` pins the absence mechanically, alongside the eval and audit bans it already holds.

Every transcript byte is untrusted data: parsed and classified, never interpreted as instructions and never executed. `excerpt` (`scripts/lib/transcript.ts`) is the one chokepoint for transcript-derived text reaching a finding — sanitize, then cap at 200 characters with an `omittedChars` count — and a live agent's transcript is never read into an agent's own context; this engine reports counts and short excerpts only, run by the operator or the cockpit's tick, never inline in a dispatched agent's prompt.

| Check | Source |
| --- | --- |
| Every case in both decision-case tables (`scripts/port-forensics/cases/*.json`) resolves and passes | `scripts/checks/forensics.ts` |
| `usesShellLoop`/`targetsGhOrGit` (reimplemented, not imported, since `scripts/` may not depend on a shipped path's internals) agree with `plugins/port/hooks/lib/command-rules.mjs`'s own originals, both directions | `scripts/checks/forensics.ts` |
| The item-correlation stage list is pinned against `plugins/port/agents/`'s real basenames and `apps/desktop`'s own `PORT_STAGE_AGENTS`, both directions | `scripts/checks/forensics.ts` |
| Read-only: no mutating `gh` subcommand, no `--jq`, no `shell: true`, no second child process spawn, no whole-transcript dump flag | `scripts/checks/forensics.ts` |
| No sanitizer reimplemented outside `scripts/lib/transcript.ts`; no `running`/`alive`/`isLive`-named identifier | `scripts/checks/forensics.ts` |
| `commands.forensics` never appears in `commands.checks` | `scripts/checks/evals.ts`, `scripts/checks/forensics.ts` |
| The fixture tree (`scripts/port-forensics/fixtures/`) exercises `scan.ts`'s resolve and degrade paths, and `report.ts`'s own orchestration end to end | `scripts/checks/forensics.ts` |

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

## Trajectory record

The pipeline's own two evaluation tiers — end-to-end (`evals/`) and component-level (`scripts/checks/`) — say nothing about what actually happened during a real run: how long a stage took, how often something got denied, which ticket looped, whether the cockpit was even ticking. That is the trajectory-level tier this section adds (#187), sitting between the two: not a static assertion and not a scored eval, but a machine-readable record of production runs, built on the tick engine (`commands.tick`) that already computes every tick decision deterministically.

**Two local files, both gitignored (`.agents/` already is):**

- `.agents/events.jsonl` — one JSON line per tick-engine event: `run-start` (from `start`), `tick` (from `plan`), `tick-commit` (from `commit`). Rotates only at `start`, never mid-tick, at an 8 MB cap — two generations, ~16 MB ceiling.
- `.agents/denials.log` — unchanged, deliberately **not** widened or rotated (its format already has three readers — the guard hook, the cockpit, and the desktop app — and rotating it would silently truncate the desktop's history). The tick record instead consumes it as a source: each tick's delta folds into that `tick` event's own `denials` field.

**The reader:** `node scripts/port-tick.ts report [--since <iso>] [--run <id>]` — read-only, local-only, no `gh` call. Answers this ticket's four questions directly: stage duration by model (`dispatches.byStage`/`byStageMedianSeconds`), failures/denials/escalations (`ticks.incomplete`/`blind` + `denials` + `escalations`), cycles per ticket (`items[].reviewCycles`), and whether the cockpit was ticking (`cadence.gaps`). An absent `.agents/events.jsonl` reports "nothing recorded", never a zero-filled report or a crash — durations are always derived from tick boundaries (±270s), never a precise per-dispatch figure, which is what `commands.budget`'s own ledger (#188) is for.

**Never in `commands.checks`.** It reads a gitignored path absent from a dispatched agent's worktree and from CI, the same placement layer 2's own `audit` establishes for operator-facing tooling that needs a real repository to run against.

| Check | Source |
| --- | --- |
| `tick-cases` covers the three new decision families (`events`, `denials`, `report`), same as every other pure tick-engine module | `scripts/checks/tick.ts` |
| Write-only rail: nothing but `port-tick.ts` and `report.ts` itself imports `events.ts`/`report.ts`; `events.ts` exports no `read`/`parse`-named function | `scripts/checks/tick-events.ts` |
| `formatEvent`'s envelope contract: parses as JSON, carries `v`/`ts`/`runId`/`repo`/`kind`, no raw newline, caps at 8 KB with `truncated: true` | `scripts/checks/tick-events.ts` |
| `DENIAL_DECISIONS` equals `agent-guard.mjs`'s own logged decisions and the desktop app's `CURRENT_DECISIONS`, both directions | `scripts/checks/tick-events.ts` |
| The 8 MB rotation cap is a literal | `scripts/checks/tick-events.ts` |
| `SKILL.md` names `<commands.tick> start` and `--live`; `TICK-PROSE.md` carries the moved "Denial report" section | `scripts/checks/tick.ts` |
