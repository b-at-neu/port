# Testing the plugin

This plugin is almost entirely prompts, which makes it easy to change confidently and wrongly. Three layers, deliberately separated by cost.

## Layer 1 — static checks

```bash
node scripts/checks.mjs
```

No dependencies, no plugin install, no model calls. Runs in seconds, in CI on every pull request, and in an agent's worktree before it pushes.

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
| `plugins/port/skills/pipeline/SKILL.md` carries the `<labels.approved>` carve-out's precondition phrase "only when a check on it has gone red", and the approved-announcement copy shows a check conclusion | The cockpit's terminal-state rail widening back into a general licence to revisit `approved` (#143) |
| `PIPELINE.md`'s rebase protocol declares the widened auto-resolvable rows ("take the union", "deterministic order", "apply the addition inside the new structure"), the never-auto-resolve list, and the escalation's `Recommendation` / `D<n>` decision-ID form | The rebase protocol regressing to fail-closed-and-narrate instead of resolve-and-escalate-as-options (#143) |
| `plugins/port/skills/pipeline/SKILL.md` names the `.temp/dispatch-log.md` artifact, states the literal preconditions "reset only an item this session's own dispatch log records" and "at most one automatic reset per item per session", and its `<labels.approved>` carve-out names "GitHub reports it conflicting with its base" | A dead-agent reset firing on an item this session never dispatched, or firing more than once per crash loop (#150) |
| `review-agent.md` reads `mergeable`, checks for `CONFLICTING`, and states the literal phrase "no verdict is formed on a pull request that cannot be merged"; `revise-agent.md` and `PIPELINE.md` both name `## Rebase required`; `PIPELINE.md` records the rebase-on-demand decision ("never on a schedule") | A verdict formed, or a rebase scheduled speculatively, against a diff GitHub never actually validated (#150) |
| The `` ```files ``` `` fence tag exists in both `PIPELINE.md` and `plan-agent.md`; `PIPELINE.md` records the hold decision ("never a new label and never GitHub's dependency graph"); `SKILL.md`'s gate names its precondition ("only when no in-flight item's plan claims the same file"), the `<labels.prOpened>` occupied-set input, and the `dispatch #N anyway` override | Two plans claiming the same file dispatched concurrently, so whichever pull request merges first invalidates the other's rebase (#135) |
| The committed `port` marketplace entry in `.claude/settings.json` keeps a `ref` (release branch or `v<semver>` tag) and `autoUpdate: true` | A bare `marketplace add` rewriting the entry back to its unpinned form, silently tracking the default branch instead of a release (#146) |
| The README's documented install source (`claude plugin marketplace add b-at-neu/port…`) stays pinned to an `@<ref>` or `#<ref>` | A docs edit quietly restoring default-branch tracking on the very command adopters copy-paste (#146) |

Each rule is worth testing by breaking it deliberately. If a check cannot be made to fail, it is not a check.

The script reports full schema validation as **skipped**, because a draft 2020-12 validator is a dependency and the script must run where none is installed. CI does that part.

## Layer 2 — artifact assertions on real runs

```bash
node scripts/artifacts.mjs 65      # audit named pull requests
node scripts/artifacts.mjs         # the 5 most recent, plus the parked sweep
node scripts/artifacts.mjs --limit 10
```

Needs `gh` and a login; no model calls. This repository's own pull requests are the fixtures — no sandbox repository to maintain, and no stubbed `gh` whose fidelity has to be trusted.

It targets a real exposure: the output formats live in `PIPELINE.md` prose and were asserted nowhere. The one that matters most is the review heading — the cockpit **counts** occurrences of the literal `## Code Review` to derive the cycle number, so renaming it silently breaks the cycle cap and the escalating bar, with no error anywhere. That is why the literal prefix is asserted separately from the rest of the heading.

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
| The closing issue has an `## Implementation Plan`, and `SESSION REQUIRED` appears on both surfaces or neither | Session-required tickets |
| An operator-only testing step on the issue plan reaches the pull request's testing plan | Session-required tickets |

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
