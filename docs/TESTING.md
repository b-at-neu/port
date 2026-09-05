# Testing the plugin

This plugin is almost entirely prompts, which makes it easy to change confidently and wrongly. Three layers, deliberately separated by cost.

## Layer 1 — static checks

```bash
node scripts/checks.mjs
```

No dependencies, no plugin install, no model calls. Runs in seconds, in an agent's worktree before it pushes, and in CI's `run-static-checks` job on every pull request, matrixed across `ubuntu-latest`, `macos-latest`, and `windows-latest` with no install step — the empty `node_modules` in that job is what makes the dependency-free invariant an executed assertion rather than a comment. This is the only thing an agent runs before pushing; `.github/workflows/checks.yml` runs two further jobs CI-only: `run-schema-fixtures` (ubuntu only, full JSON Schema validation) and `run-app-checks` (the same three-OS matrix, `apps/desktop`'s typecheck/lint/test/build — see CONTRIBUTING.md → "Working on the desktop app" for why it stays out of `commands.checks`).

**These guard against silence.** A skill or agent whose frontmatter is malformed is *absent* from Claude Code's component inventory rather than reported as an error, so nothing complains — the component simply is not there. Same for a hook. Every check below exists because something broke that way:

| Check | Guards against |
| --- | --- |
| Frontmatter parses, has `name` and `description`, and `name` matches its path | A component silently missing from the inventory |
| `hooks.json` `command` is a shell string, not an argv array | The hook loading as `Hooks (0)` — no error, just absent |
| Templates and manifests are valid JSON | Anything downstream reading `undefined` |
| Label keys in `labels.json` match the schema exactly, both directions | Two files listing the same vocabulary and drifting |
| Every label `color` is a well-formed hex, and no two labels share one | A role's ramp collapsing back to one repeated hex |
| `commands.checks` entries are `{run, fix}` objects | Bare strings, which parse fine and read plausibly while every consumer gets `undefined` |
| Stale references — the former installer name, the former config location, unprefixed skill names | Docs naming things that were renamed or moved |
| Every eval case declares `name`, `prompt` and `graders`, and every grader resolves both ways | A layer 3 case broken by a rename, invisible while the evals cannot run |
| No `commands.checks` entry invokes an eval or the layer 2 audit | Every dispatched agent spawning its own model runs before it can push |
| The shell-discipline block between its marker comments in `PIPELINE.md` exists, and every agent granting Bash carries a byte-identical copy | Shell-shape rules present in one agent and not its siblings (#66) |
| The session-required determination still names the testing steps, and the `operator-only` literal exists in both agent files | #118 |
| Every `hooks.json` matcher's `command` references a file that actually exists, and `PreToolUse` declares a matcher covering `Bash` and one covering the write tools | The guard hook silently absent after a rename or a dropped matcher (#67) |
| The guard hook's classifier — `hooks/lib/guard-rules.mjs` — denies a subagent's allowlist-missing Bash command and a subagent's write to a `sessionRequiredPaths` path, never denies the same calls without an agent signal, and each of the three caller signals (`agent_type`, transcript, worktree) reaches `deny` on its own | The mechanism that actually denies, independent of parent-session mode (#67) |
| A spawned run of the guard hook itself emits the deny JSON and a `deny` log line for a subagent's allowlist miss, no stdout and a `miss` line for the same command from a non-subagent, no log line at all for an allowed command, stays silent outside a port-managed repository, and logs `hook-error` rather than crashing on a malformed payload | Stdin/stdout/exit-code wiring the classifier's direct import cannot see (#67) |
| The cockpit's inline `Config key \| Default name` table names the same keys and default names as `labels.json`, both directions | The cockpit resolving a config key it cannot map to a real label name (#61) |
| No `--label`/`--add-label`/`--remove-label` argument under `plugins/**/*.md` is a bare config key whose name differs from it | A key typed where a resolved label name belongs, matching nothing silently (#61) |
| The guard hook's classifier denies a `gh`/`git` call wrapped in a shell `for`/`while`/`until` loop for the cockpit as well as a subagent, never for an `impl-<n>` operator worktree, and never trips on loop keywords quoted inside a `-b`/`-m`/`--jq` argument | The cockpit wrapping `gh` in a loop and losing everything but the first iteration when the turn dies mid-loop (#120) |
| The guard hook's classifier denies a `gh pr edit`/`gh issue edit --remove-label` call targeting `<labels.needsHuman>` unless a recent operator message names that item, allows it unverified (logged as `gate-clear`, never silently) when the transcript can't be read, and never guards an `impl-<n>` operator worktree | The cockpit clearing its own `needs human` escalation gate, unprompted, under throughput pressure (#138) |
| `review-agent.md` reads `statusCheckRollup` and `--watch`, states the literal phrase "no verdict is formed while any check on the head commit is pending", conditions the approval-gate carve-out on `modules.approvalGate`, and names the `blocked — checks pending` verdict; no agent or skill file names a literal CI check name | A verdict formed before its evidence exists, and a carve-out hard-coded to one repository's check names (#143) |
| `plugins/port/skills/pipeline/SKILL.md` carries the `<labels.approved>` carve-out's precondition phrase "only when a check on it has gone red, or a same-SHA refresh loop is stuck", and the approved-announcement copy shows a check conclusion | The cockpit's terminal-state rail widening back into a general licence to revisit `approved` (#143) |
| `PIPELINE.md`'s rebase protocol declares the widened auto-resolvable rows ("take the union", "deterministic order", "apply the addition inside the new structure"), the never-auto-resolve list, and the escalation's `Recommendation` / `D<n>` decision-ID form | The rebase protocol regressing to fail-closed-and-narrate instead of resolve-and-escalate-as-options (#143) |
| `plugins/port/skills/pipeline/SKILL.md` names the `.temp/dispatch-log.md` artifact, states the literal preconditions "reset only an item this session's own dispatch log records" and "at most one automatic reset per item per session", and its `<labels.approved>` carve-out names "GitHub reports it conflicting with its base" | A dead-agent reset firing on an item this session never dispatched, or firing more than once per crash loop (#150) |
| `review-agent.md` reads `mergeable`, checks for `CONFLICTING`, states the literal phrase "no verdict is formed on a pull request that cannot be merged", and routes its mergeability exit to `<labels.refreshBranch>`; `review-agent.md` and `PIPELINE.md` both name `## Rebase required`; `PIPELINE.md` records the rebase-on-demand decision ("never on a schedule") | A verdict formed, or a rebase scheduled speculatively, against a diff GitHub never actually validated (#150) |
| `labels.json`'s `refreshBranch`/`refreshing` entries are both `module: "core"`; `PIPELINE.md` and `SKILL.md` both carry the literal phrase "a refresh consumes no review cycle"; `SKILL.md` carries "never refresh a head SHA this session already refreshed", "at most 5 refreshes per tick, oldest first", "at most 3 consecutive refreshes per pull request", and "leaves `<labels.approved>` in place"; `PIPELINE.md` still carries "never on a schedule" | Refresh's bounds — the same-SHA guard, the per-tick and per-pull-request caps, and the review-cycle exemption — regressing to prose with nothing checking it, now that #189 made refresh the pipeline's only rebase route (#189) |
| No file under `plugins/`, `schema/`, `apps/desktop/src/`, `evals/`, `.github/`, or `.claude/port.config.json` contains the string `previewDatabase` | A deleted config flag's name surviving as dead scaffolding somewhere it was never swept (#189) |
| The `` ```files ``` `` fence tag exists in both `PIPELINE.md` and `plan-agent.md`; `PIPELINE.md` records the hold decision ("never a new label and never GitHub's dependency graph"); `SKILL.md`'s gate names the `<labels.prOpened>` occupied-set input and the `dispatch #N anyway` override | Two plans claiming the same file dispatched concurrently, so whichever pull request merges first invalidates the other's rebase (#135) |
| The schema and template carry `concurrency.sharedFiles` and `concurrency.overlapThreshold` with their documented `default: 2` and `minimum: 1`; `PIPELINE.md` names both keys and states "fails open toward dispatch"; `SKILL.md` names both keys and states "counted per in-flight item, never pooled" and the reworded precondition "only when no single in-flight item's plan claims concurrency.overlapThreshold or more of the same non-shared files" | A gate that held on any shared path — including append-mostly registries and docs a rebase resolves as a union — serialized 23 of 27 overlapping pull request pairs that could have run in parallel (#190) |
| The committed `port` marketplace entry in `.claude/settings.json` keeps a `ref` (release branch or `v<semver>` tag) and `autoUpdate: true` | A bare `marketplace add` rewriting the entry back to its unpinned form, silently tracking the default branch instead of a release (#146) |
| The README's documented install source (`claude plugin marketplace add b-at-neu/port…`) stays pinned to an `@<ref>` or `#<ref>` | A docs edit quietly restoring default-branch tracking on the very command adopters copy-paste (#146) |
| Every `SESSION REQUIRED` mention in a prompt file is inline code or the canonical `> **SESSION REQUIRED:** <reason>` rendering, and `PIPELINE.md`'s own canonical example matches that rendering exactly | A reworded marker that no consumer recognizes, false-positiving on a ticket that only discusses the mechanism (#156) |
| No `--label`/`--add-label`/`--remove-label` argument, and no GraphQL `labels: [...]` list, under `plugins/**/*.md` is a bare config key whose name differs from it | A config key surviving the tick's collapse into a GraphQL query and matching nothing silently, the exact #61 failure mode one syntax over (#148) |
| `SKILL.md`'s `## Tick procedure` section names `gh api graphql`, `--include`, and `.temp/tick-state.md`, and carries no per-label `gh issue list`/`gh pr list --label` poll | A tick regressing from one collapsed round trip back to ~15 per-label REST calls (#148) |
| The pacing ladder's constants (`270`, `540`, `1080`, `1800`) and its reset-on-change and never-stop preconditions are literal, checkable phrases in `SKILL.md` | The two-speed pacing rule, which measured as one speed in a real 25-hour run, regressing back in after the ladder replaces it (#148) |
| `SKILL.md` contains no `sleep <n>`-shaped busy-wait | The cockpit blocking a turn on `sleep`/`--watch` instead of letting the next scheduled tick or an event-driven completion do the waiting (#148) |
| `SKILL.md` states the client-side ownership precondition ("never acted on, only reported") and the blind-tick precondition ("dispatch nothing, run no hygiene, reset nothing") | Dropping the per-alias assignee filter silently dropping the ownership rail with it, and a failed collapsed query being read as an empty, all-clear tick (#148) |
| `plugins/port/templates/artifacts.mjs` carries no relative import | The one file an adopting repository copies alone breaking silently outside this checkout (#149) |
| Its exported `LABELS` table and `labels.json` agree on keys, names, and modules, both directions | `audit`'s label resolution drifting from the source of truth now that it can't import the file directly (#149) |
| Its exported patterns each accept a good example and reject a bad one, including the real historical failure — a paragraph subject with no `#N ` prefix | A pattern that cannot be made to fail is not a pattern (#149) |
| `SKILL.md`'s cycle cap no longer conditions escalation on the latest review still carrying Critical or Medium findings, and states the cap is unconditional; its zero-diff review gate names `commit.oid`, `headRefOid`, and `## Gate cleared`; `PIPELINE.md` states both rules too | A review cycle cap that never fires on a clean-but-unmerged bounce, and a review dispatched twice against a diff it already graded (#162) |
| `plugins/port/templates/worktrees.mjs` carries no relative import, no `execSync`, no `shell: true`, and never invokes `git fetch` or `git worktree add` | The one file an adopting repository copies alone breaking silently outside this checkout, or reaching outside its contract (#144) |
| Its exported `parsePorcelain`, `correlate`, and `classifyCandidate` each resolve their documented cases — every correlation rung in order with `#0` excluded, and the classification precedence (`outside` → `protect` → `locked` → `dirty` → `active` → `done`/`no-work` → `unresolved`) | The correlation ladder or the classification precedence silently drifting from what `PIPELINE.md` documents (#144) |
| The guard hook's classifier denies a `claude plugin install`/`uninstall`/`marketplace add`/`marketplace remove` call from any cwd under `.claude/worktrees/` — for a dispatched agent, a plain session, **and** an `impl-<n>` operator worktree alike — allows the same commands from the main checkout, and never trips on a read-only subcommand or the words quoted inside an unrelated argument | An install performed from inside any managed worktree silently repointing every session on the machine via the shared `installPath` (#144) |
| `plugins/port/skills/pipeline/SKILL.md`'s hygiene section names `commands.worktrees` and never invokes `git worktree remove --force` directly; the schema, the template, and this repository's own self-hosted config all declare `commands.worktrees` | The cockpit's worktree hygiene collapsing back into the prose #62 already tried once, or the config key existing in only some of the places that must agree on it (#144) |
| `.github/workflows/checks.yml` names all three runner labels (`ubuntu-latest`, `macos-latest`, `windows-latest`) | Quietly dropping a platform after a red run, which would look like a tidy-up in review (#73) |
| `apps/desktop/src/shared/labels/vocabulary.ts`'s hand-maintained `LABEL_KEYS` array matches `labels.json`'s keys, both directions | The one literal union that can't be derived from the JSON import (TypeScript widens JSON strings to `string`) drifting from the template it must mirror (#75) |
| No non-test file under `apps/desktop/src/` contains a string literal equal to a template default `name` whose `key !== name` (widened from `shared/labels/` by #74, now covering `main/github/` too) | The app retyping a resolved label name by hand instead of reading it from the `LABEL_DEFAULTS` import — the same second-transcription drift this ticket exists to prevent (#75) |
| `ARCHITECTURE.md`'s `## Map` table parses at least one row, every row's path exists on disk, every tracked top-level directory is covered by at least one row, and every `Ships` cell is exactly `yes` or `no` | The repository map going stale in either direction — a moved or renamed path, or a new top-level directory with no row (#167) |
| `scripts/checks.mjs` calls none of `fail`/`note`/`ok` itself, and every `.mjs` file under `scripts/checks/` is imported by the runner | A topic module present on disk but never wired in, running nothing and reporting nothing — or check logic silently re-absorbed into the runner the split exists to keep thin (#168) |
| Every backticked or bare path-shaped token in a shipped file under `plugins/port/` that this checkout provably has outside `plugins/port/`, with no counterpart inside it, fails; a token that resolves nowhere at all is skipped | A shipped file referencing a repository-only doc or script, which dangles in every adopter's plugin cache (#169) |
| `.github/workflows/approval-check.yml`/`artifacts.yml`, each rendered from `plugins/port/templates/*.yml` with this repository's own config and compared whitespace-normalized (comment paragraphs only — non-comment lines byte-exact), both directions | The live workflow that actually gates merges drifting silently from the template every adopter installs, or vice versa (#170) |
| The cockpit's inline label table's Role column matches `labels.json`'s `role` field, both directions | The `role` field the blocking-label derivation reads from drifting from the table it was copied from (#170) |
| `child_process` is referenced under `apps/desktop/src/` only in `main/platform/run.ts`, and that file's `node:child_process` import binds only `execFile`/`spawn` | A POSIX shell-out, or a synchronous/shell-spawning API, creeping into an adapter instead of staying behind the platform layer (#72) |
| `main/platform/run.ts`'s `KNOWN_COMMANDS` contains no POSIX-only/shell utility (`grep`, `find`, `wc`, `stat`, `file`, `ls`, `cat`, `sed`, `awk`, `head`, `tail`, `which`, `xargs`, `sh`, `bash`, `cmd`, `powershell`, `pwsh`) | A POSIX-only or shell-only executable becoming spawnable, which fails only on Windows at runtime instead of at compile time (#72) |
| No file under `apps/desktop/src/` sets `shell: true`, calls `execSync`/`spawnSync`, or calls any other synchronous filesystem function, and no *production* file outside `main/platform/` imports `node:fs`/`node:fs/promises` (a `*.test.ts` fixture may, to set up a real `mkdtemp` directory) | The cross-platform command and path layer's own rail — shelling out or blocking the main process — regressing silently in a future adapter (#72) |
| Every tracked, non-excluded file is at or under the configured line limit, every allowlisted file matches its recorded count exactly, and the limit `ENGINEERING.md` states equals the one the config sets | A file growing past the bar with nothing to object, and the debt list going stale in either direction (#177) |
| `schema/port.config.schema.json` is imported by exactly one file under `apps/desktop/src/`, and that file does import it | The registry silently re-deriving the config contract instead of reading the shipped schema, or the guard passing vacuously once the importer is deleted (#74) |
| No non-test file under `apps/desktop/src/main/registry/` contains a string literal equal to a schema `default` value whose type is `string` (`dev`, `main`, `opus`, `sonnet`, `github`) | A schema default retyped by hand instead of read off the `CONFIG_DEFAULTS` import, drifting the moment the schema changes (#74) |
| The `desktop-label-defaults` retyped-name guard covers all of `apps/desktop/src/`, not just `shared/labels/` | The registry or the renderer retyping a resolved label name instead of importing it, now that both are consumers (#74) |
| No file under `apps/desktop/src/main/github/` calls GraphQL `search(`, and none passes `--jq` to `gh` | The index-backed `search` field's ingestion lag reintroducing silent staleness, or `gh` silently skipping its own `--jq` filter on a partial-error response this adapter must read (#76) |
| `apps/desktop/src/main/github/adapter.ts`'s `_kindsCoverGhResult` assertion pins `shared/github/types.ts`'s hand-maintained `PipelineFailureKind` against the platform layer's real `GhResult`/`CommandResult` failure kinds and `envelope.ts`'s own `EnvelopeFailureKind`, both directions | A new failure kind landing in the platform layer or the envelope classifier and silently falling into the renderer-safe union's `unknown` bucket instead of failing `pnpm typecheck` (#76) |
| `runCommand(` is called under `apps/desktop/src/` only from `main/platform/` | A second adapter spawning `gh`/`git` itself, or hand-rolling a second failure classifier, instead of going through the platform layer (#76) |
| No failure path in `envelope.ts`'s `classifyFailure` returns `{ ok: true }`-shaped data for a request that did not actually succeed — a partial response's surviving aliases are the one case that returns real data alongside a failure | A blind fetch (no `gh` data, or an unresolvable repository) being read as an empty pipeline board (#76) |
| `branchModelError` rejects a null `branches.production` without an explicit `modules.release: false` and a `production` resolving equal to `integration`, over `.claude/port.config.json`, the shipped template, and every `schema/fixtures/valid.*.json`; `approval-check.yml`'s template carries no `{{production}}` token; every `{{name}}` in `permissions.base.json` is named in `init/SKILL.md`, whose `{{packageManager}}` drop-rule bullet also names `{{production}}`; `PIPELINE.md`'s `<production>` row names `null` and its CI merge gate section names the single-branch case | A single-branch repository (null `production`) silently asking for both no release flow and a release flow, or a dropped placeholder left unsubstituted for an adopter with one branch (#54) |
| `@anthropic-ai/claude-agent-sdk` is referenced under `apps/desktop/src/` only in `main/sessions/sdk.ts`, and that file does reference it | A second reader spawning the SDK directly instead of going through the one lazy-imported seam (#78) |
| `main/sessions/classify.ts`'s `PORT_STAGE_AGENTS` array matches the `.md` basenames under `plugins/port/agents/`, both directions, and `pipeline`/`implement` exist as directories under `plugins/port/skills/` | The stage union or the role ladder's first-prompt rung drifting from the real agents and skills it names (#78) |
| No non-test file under `main/sessions/` or `shared/sessions/` contains `running`, `alive`, or `isLive` as an identifier or string literal outside a comment | A local transcript's recency being reported as liveness, the exact distinction Decision 4 exists to hold (#78) |
| No file under `apps/desktop/src/main/local/` references `gh(`/`ghJson(`/`main/github`, and at least one imports `git` from the platform layer | A second `gh`-calling adapter landing beside the one #76 already established, or the local-only rail (Decision 1) passing vacuously once the git call is removed (#77) |
| No file under `apps/desktop/src/main/local/` contains the literal `.claude/worktrees` | The worktree producer/scan being hard-coded to one directory name instead of derived from the registered worktree's own basename (#77) |
| `templates/worktrees.mjs`'s exported `correlate` resolves every case in `main/local/correlation.cases.json` identically to the desktop `correlate`, and that table covers all four rung names, a `#0` case, and a `null` case | The reclaimer's and the desktop app's correlation ladders silently disagreeing about which issue a worktree belongs to (#77) |

Each rule is worth testing by breaking it deliberately. If a check cannot be made to fail, it is not a check.

The script reports full schema validation as **skipped**, because a draft 2020-12 validator is a dependency and the script must run where none is installed. CI does that part.

## Layer 2 — artifact assertions on real runs

The output formats live in `PIPELINE.md` prose and, until now, were asserted nowhere. The one that matters most is the review heading — the cockpit **counts** occurrences of the literal `## Code Review` to derive the cycle number, so renaming it silently breaks the cycle cap and the escalating bar, with no error anywhere. That is why the literal prefix is asserted separately from the rest of the heading.

`plugins/port/templates/artifacts.mjs` is the one executable statement of these patterns. Two modes read from the exact same constants, so there is nothing to keep in sync between them:

```bash
node plugins/port/templates/artifacts.mjs check commit .temp/commit-msg.txt --issue 149      # one artifact file, offline
node plugins/port/templates/artifacts.mjs check pr-body .temp/pr-149.md --issue 149
node plugins/port/templates/artifacts.mjs check review .temp/review-65.json --cycle 1
node plugins/port/templates/artifacts.mjs check revision .temp/revision-65.md --cycle 1

node plugins/port/templates/artifacts.mjs audit 65      # audit named pull requests
node plugins/port/templates/artifacts.mjs audit         # the 5 most recent, plus the parked sweep
node plugins/port/templates/artifacts.mjs audit --limit 10
```

**`check <kind> <file>` is the earlier net, not a second layer.** It is what `commands.artifacts` points the three stage agents at: each validates the file it just wrote — a commit message, a pull request body, a review payload, a revision note — before producing it, so a malformed one fails in the worktree seconds after it is written instead of after `<labels.approved>`. It is offline: no `gh`, no network, no config read, and it works in any worktree, including one with no `.claude/port.config.json`. A repository with no Node leaves `commands.artifacts` null and gets no production-time validation at all — `audit` below is then the only net.

**`audit [<pr>...] [--limit <n>]`** is today's `gh`-driven pass over finished pull requests, unchanged in what it asserts. Needs `gh` and a login; no model calls. This repository's own pull requests are the fixtures — no sandbox repository to maintain, and no stubbed `gh` whose fidelity has to be trusted.

| Assertion | Source |
| --- | --- |
| Body opens `Closes #N`, carries `## Summary` / `## Changes` / `## Testing plan` / `## Automated checks`, and the testing plan is a real `- [ ]` checklist | Pull request description format |
| Every review heading is `## Code Review — Cycle <n> · <approved\|needs revision\|blocked — checks pending>` with a counts line under it, cycles running 1..N | Reviews and revisions |
| Revision notes are `## Revision — Cycle <n>` plus one `fixed … · skipped … · <sha>` line, a `check <name> · <sha>` line in check-fix mode, or a `rebase onto <base> · <sha>` line in rebase-only mode, no cycle above the review count | Reviews and revisions |
| An `## Approval withdrawn` comment names both a check and a 7–40 character hex SHA | Check evidence — the `<labels.approved>` carve-out |
| A `## Rebase required` comment names both a base branch and a 7–40 character hex SHA | Rebase required |
| Commit subjects are `#N <imperative lowercase>`, under 80 characters, no trailing period, with a `Co-Authored-By:` trailer | Commit messages |
| At most one stage label; a merged pull request keeps no trigger or in-flight label | Label lifecycle |
| Nothing under `.temp/` or `.agents/` in the diff | Operating rules |
| The closing issue has an `## Implementation Plan`, and the marker is read at its slot — the plan block's first non-empty line and, on the pull request, the first non-empty line under `Closes #N` — matching on both surfaces or neither, with the canonical rendering never repeated outside either slot | Session-required tickets |
| An operator-only testing step on the issue plan reaches the pull request's testing plan | Session-required tickets |
| Reviews sharing one `commit.oid`: two is a note (the operator-authorized zero-diff re-review), three or more is a failure | Zero-diff review |

**A pull request without the `claude` marker is skipped, never failed.** A human or dependency-bot pull request is not a deviation, and the marker is what makes one the pipeline's.

**Items parked in an in-flight label are notes, never failures.** An agent may legitimately still be running, and this layer cannot tell the difference.

Each rule is worth testing by breaking it deliberately — change the expected review heading to `## Code Audit`, re-run against a real pull request, and confirm it fails. A check that cannot be made to fail is not a check.

**When a format changes deliberately, this audit is the thing that must change with it.** It encodes `PIPELINE.md` prose, so the prose and the script are one edit, not two.

**Never register the audit workflow as a required check.** It runs only on `labeled`, so requiring it leaves the check pending forever on every pull request that never reaches `approved` — and a pending required check explains nothing, which is worse than a failing one.

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
