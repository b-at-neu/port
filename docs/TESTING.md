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
| Every review heading is `## Code Review — Cycle <n> · <approved\|needs revision>` with a counts line under it, cycles running 1..N | Reviews and revisions |
| Revision notes are `## Revision — Cycle <n>` plus one `fixed … · skipped … · <sha>` line, no cycle above the review count | Reviews and revisions |
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
