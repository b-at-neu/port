# Engineering Standards

Every pipeline agent reads this document before working. It defines the quality bar beyond what is obvious from the code. Plans must account for it per feature, implementations must follow it, and review findings may cite its sections the same way they cite the plan.

This is **this repository's own** standards document, not a template — `plugins/port/templates/ENGINEERING.template.md` is the skeleton `/port:init` installs elsewhere. Concrete paths like `plugins/port/**` are therefore correct here, and only here.

**Where things live is not this document's job.** [ARCHITECTURE.md](../ARCHITECTURE.md) is the canonical repository map and the authority on the ship boundary; it carries its own layer 1 pin (`scripts/checks.mjs` → "Repository map covers the real tree, both directions"), so restating its table here would create a second copy with nothing pinning it — exactly what §2 forbids. This document covers *how* to write, not *where* to put it.

**Citations name checks and sections, never line numbers.** `scripts/checks.mjs` and `docs/PIPELINE.md` are the two most-churned files in the repository, so a line reference in either is stale within days. Every citation below names a `// --- ` check block or a markdown heading, both of which survive edits and file splits.

**Stack:** Markdown agent and skill definitions (the product) · Node.js ≥22 ESM scripts with zero runtime dependencies (static checks, artifact validation, worktree reclamation) · JSON Schema draft 2020-12 · GitHub Actions · `gh` CLI for all GitHub I/O · a pnpm workspace with TypeScript and Electron (`apps/desktop`)

## 1. Architecture

`plugins/port/docs/PIPELINE.md` is the single source of truth for operating rules, the label lifecycle, the permission model, and every output format. Every agent and skill references it and restates **only** what is unique to itself. A rule belonging to more than one stage goes there, not into each stage — and when it must appear in several files, it goes in as a byte-identical block with a pin (see §2).

**Hook and script code separates pure decision logic from I/O.** `hooks/lib/guard-rules.mjs` exports pure functions unit-tested directly; `hooks/agent-guard.mjs` is the thin stdin/stdout/exit-code wrapper, tested separately by spawning the real script ("Guard hook classifier" and "Guard hook end-to-end wiring"). The same split applies to the worktree reclamation script ("Worktree reclamation classifier"). New logic goes in the library, not the wrapper — the wrapper's tests cannot see a classifier bug and the classifier's tests cannot see a wiring bug.

**Scripts follow one runnable entry point plus a shared library.** `scripts/checks.mjs` is the entry; `scripts/lib/report.mjs` is a deliberately dumb collector and printer, shared by layers 1 and 2, which "decides nothing" (its own header). The scripts decide what is worth checking; the reporter decides nothing.

**A file that an adopting repository copies alone must be self-contained.** `plugins/port/templates/artifacts.mjs` and `templates/worktrees.mjs` carry no relative imports, because an import resolving only inside this checkout breaks silently for every adopter while passing here ("Artifact validator template is self-contained", "Worktree reclamation template is self-contained and cross-platform"). Cross-platform behaviour is part of the same contract — these run on an adopter's Windows machine, not just this one.

**No repository-specific value is ever a literal in prompt text.** Label names, check names, branch names, and the repository slug are resolved from `.claude/port.config.json` or from PIPELINE.md's default table at read time. A literal label name silently matches nothing — `gh issue list --label <unknown>` exits 0 with an empty result — and a literal CI check name breaks the moment a repository renames its workflow job ("No config key appears as a literal --label argument", "Generality guard — no literal CI check name in a stage prompt"). The test to apply: **would this behave correctly in a freshly `/port:init`-ed repository with renamed labels, a single branch, and a different set of CI checks?**

## 2. Data and integrity

`.claude/port.config.json` validates against `schema/port.config.schema.json` (draft 2020-12). Fixtures come in pairs — `schema/fixtures/valid.*.json` must validate and `invalid.*.json` must be rejected — and both directions are asserted, because a fixture set that only proves acceptance proves nothing ("Schema fixtures still discriminate", plus the `run-schema-fixtures` CI job which does the full validation layer 1 deliberately cannot).

**Any content duplicated across files gets a mechanical assertion pinning the copies together, in both directions — never a "keep in sync" comment.** This is the repository's most consistently applied rule. The existing pins:

| Copies | Check |
| --- | --- |
| `templates/labels.json` ↔ the schema | "Label vocabulary matches the schema" |
| `templates/artifacts.mjs`'s `LABELS` ↔ `labels.json` | "Artifact validator's LABELS table matches labels.json" |
| `pipeline/SKILL.md`'s inline label table ↔ `labels.json` | "Cockpit's inline label-vocabulary table matches labels.json" |
| `apps/desktop`'s `LABEL_KEYS` ↔ `labels.json` | "Desktop app's LABEL_KEYS matches labels.json, both directions" |
| The shell-discipline block ↔ its canonical copy in PIPELINE.md | "Shell-discipline block stays byte-identical everywhere it fires" |
| `ARCHITECTURE.md`'s map ↔ the real tree | "Repository map covers the real tree, both directions" |

**If a change introduces a further copy of anything, it introduces its pin in the same commit.** A comment asking a future reader to remember is not a pin.

**Config shape is asserted, not assumed.** `commands.checks` entries must be `{run, fix}` objects: a bare string is still valid JSON and reads plausibly while every consumer reading `entry.run` gets `undefined` ("The config template matches its own schema's shape").

## 3. Security

**Broad allow, authoritative deny.** The allowlist grants whole development-command categories; the deny list is the real safety surface for dangerous or interactive commands, and deny beats allow at every scope. Any permission change is reflected in both `templates/permissions.base.json` and PIPELINE.md's permission model section.

**The `PreToolUse` guard hook is the enforcement.** `permissionMode: dontAsk` in agent frontmatter stays as declared intent and a second line of defence, but has never been observed denying anything on its own (PIPELINE.md → "Why background dispatch needs care"). When a denial matters, the hook is what must change and what must be tested.

**The guard's rails are not subagent-only.** Two apply to any caller including the cockpit's own session, because the cockpit violated them under throughput pressure: no `gh`/`git` inside a shell loop, and no clearing `<labels.needsHuman>` unless a recent operator message names that item. A third denies plugin install or marketplace mutation from inside any worktree, since every scope resolves to the same on-disk `installPath` and would silently repoint every session on the machine.

**`sessionRequiredPaths` is a harness-level boundary no dispatched subagent can cross, and settings cannot grant it back.** A plan writing under those paths routes to `/port:implement` in an operator session; it is never worked around.

**A hook returns immediately outside a port-managed repository.** Installed at user scope the plugin loads in every session, so without that guard, installing it changes behaviour in every unrelated project on the machine.

**A hook records a harness decision; it never re-derives one.** Re-implementing permission matching inside a hook drifts from the original and reports what the hook *predicts* happened rather than what did.

**Known gaps are documented rather than silently tolerated:** shell redirection through an allowed command cannot be denied by pattern, because matching operates on parsed tokens while redirection is consumed by the shell; and a native `permissions.deny` match is not logged. "Write files with Write and Edit" is therefore a convention agents follow, not a technical guarantee.

## 4. Operator-facing completeness

The users of this system are operators reading GitHub and a terminal, so "user-facing" means every plan, review, comment, and cockpit line.

**Writing style, every output** (PIPELINE.md → "Writing style"): bullets and short sentences over paragraphs, one idea per bullet · never restate context the reader already has, reference it · omit sections that do not apply, with no "N/A" or "None" filler · no meta-commentary about the document itself · say each point exactly once, never across body, inline, and summary.

**Every failure mode states, in writing, which direction it fails toward and why.** Both directions are chosen deliberately and neither is a default:

- `SESSION REQUIRED` detection **fails open** toward dispatch, because a false positive stalls an item forever and invisibly while a false negative costs one denied edit and a retry.
- The tick **fails closed on actions, never on reporting**: a blind tick dispatches nothing, runs no hygiene, resets nothing, and never claims "all clear" — but still schedules the next wakeup.
- The CI merge gate is **deliberately fail-open** on an unlabelled pull request, with the mitigations named upstream.

**A blocked or denied action is reported exactly, never retried or routed around.** Emit `BLOCKED: <exact denied command + what you needed>` and stop; a denied command returns a hook decision with a reason, not a prompt.

**An absent signal is never read as a passing one.** An empty check rollup is pending, not green; a check with no conclusion has not passed. No verdict is formed while any check on the head commit is pending, or on a pull request GitHub reports `CONFLICTING`. Liveness is a `TaskList` call, never inferred from a label — an in-flight label means a stage *claimed* an item, never that anything is still running ("Liveness is a TaskList call, never a label inference").

**A path is not evidence.** Reporting a derived fact means resolving it, not pattern-matching a string that correlates with it: the running-plugin tell resolves the install record's commit sha rather than printing a cache path, because the path-based version reported "stale" every time under a directory source ("Running-plugin staleness is resolved, not printed from a path").

**Large or fenced markdown never goes inline to `gh`.** Write the payload under `.temp/` and pass `--body-file` or `--input`; shell quoting of backticks and code fences fails cross-platform.

## 5. Accessibility

Narrow but real, because the pipeline's whole visible state is a set of GitHub labels.

**Label colour encodes role by hue and position by lightness.** Triggers blue, in-flight amber, gates red, terminal green, each an ordered Primer ramp in pipeline order, so position within a role is legible from colour alone. Gates step two shades at a time rather than one, "so severity reads from a large lightness delta rather than hue alone — legible under red-green colour vision deficiency" (`labels.json`'s own `$comment`). Every colour is a well-formed six-digit uppercase hex and no two labels share one ("Label colours are well-formed and distinct").

**Severity is never colour-only.** Review findings carry both an emoji and the word: 🔴 Critical · 🟠 Medium · 🟡 Low · ⚪ Nit.

## 6. Performance

**Cost is measured, then reduced, then pinned.** The polling tick collapsed from roughly 15 GitHub round trips to one aliased `gh api graphql --include` call at a measured ~12 points against the 5,000/hour budget, and layer 1 now fails if a per-label poll creeps back under the Tick procedure heading ("Collapsed tick query — one round trip, never a per-label poll").

**Polling adapts to whether anything can move without a human.** The pacing ladder holds at a 270s floor whenever something will progress on its own, and otherwise backs off one rung per consecutive no-change tick — 270 → 540 → 1080 → 1800 — resetting to the floor on any observed change. The cockpit **never stops scheduling wakeups**, because it is the only dispatcher. The constants and both preconditions are literal, checkable phrases ("Pacing ladder").

**No busy-waiting.** Bounded waits use a real timeout and a capped retry count; a bare `sleep`-shaped wait is a layer 1 failure ("No busy-waiting in the cockpit skill"). The next scheduled tick is how this system waits.

**Expensive work runs proportionally to what changed.** Layer 1 is free and runs on every pull request, across a three-OS matrix; schema validation and `apps/desktop`'s typecheck, lint, test and build run as their own jobs; layer 3 evals are path-filtered to prompt changes only. **Neither the evals nor the layer 2 audit may ever enter `commands.checks`** — that list is what `impl-agent` runs before pushing, so an eval there means every dispatched agent spawning its own model runs ("Behavioural evals never enter commands.checks").

## 7. Quality bar

**Comments state why, never what.** Every check block in `scripts/checks.mjs` opens with the failure it exists to catch and, where one exists, its issue number. `labels.json` carries its entire colour rationale in a `$comment`. A comment restating the line below it has not earned its place.

**Small, focused files. No dead scaffolding, no transitional shims, and no placeholder content committed in anticipation of a later ticket.**

**A check that cannot be made to fail is not a check.** Every validator pattern is asserted against both a passing and a failing example, using the real historical failure where one exists ("Artifact validator's patterns accept a good example, reject a bad one"). Every new rule is worth breaking deliberately once, to confirm it catches anything at all.

**A check must be able to distinguish the state it exists to detect.** `diff -rq` returned silence while both the cache and the checkout sat 42 commits behind `origin/dev` — a verification that passes in exactly the situation it was written to catch is worse than none, because it converts an unknown into a false assurance. Prefer a check whose failure mode you have observed.

**Every fixed regression leaves a mechanical guard behind, tagged with its issue number.** Layer 1 pins the literal phrase or contract that constituted the fix, so a future edit quietly reverting the reasoning fails in CI rather than in a live pipeline run. A prose-only fix to a prompt is incomplete; `docs/TESTING.md`'s table is the running record.

**Rails are checkable preconditions, not bare prohibitions.** "Never do X" prose was violated twice under throughput pressure. A rail is instead shaped as something testable — `unblock #N` before a gate clears, "only when a check on it has gone red" before `approved` is removed — and layer 1 fails if either reverts to prose with nothing to check ("Cockpit rails stay checkable preconditions, not bare prohibitions").

**Component frontmatter is exact.** `name` must equal the file's basename for an agent and its directory name for a skill, and `description` must be non-empty ("Components parse and declare what they must"). A malformed component is *absent* from Claude Code's inventory rather than reported as an error, so nothing complains.

**Eval discipline:** one behaviour per case — if a grader needs "and", it is two cases · apply pressure, since a rule is only worth testing where following it costs something · grade the artifact, not the narration · name the failure the grader exists to catch at the top of the grader.

**Commit subjects are `#<issue> <imperative lowercase summary>`**, under 80 characters, no trailing period, `#0` when a commit genuinely has no issue. Write the message to a file and use `git commit -F <file>`, never inline `-m`, which collapses on Windows and drops the subject and co-authorship.

## 8. Pre-pull-request self-check

- [ ] Is this checkout current? `git rev-list --count HEAD..origin/dev` must be `0` — analysis and citations from a stale tree are wrong in ways that look right.
- [ ] Every new or changed agent/skill has valid frontmatter: `name` matches its file or directory name, `description` is non-empty.
- [ ] If a Bash-granting agent was touched, its shell-discipline block is still byte-identical to PIPELINE.md's canonical copy.
- [ ] No label name, CI check name, branch name, or repository slug appears as a literal in prompt text.
- [ ] Would this behave correctly in a freshly `/port:init`-ed repository with renamed labels, a single branch, and different CI checks?
- [ ] Any content newly duplicated across two files has its mechanical pin added in the same commit.
- [ ] If a pinned file changed, its counterpart still agrees — and layer 1 says so, in both directions.
- [ ] Every new check was made to fail once before being trusted to pass, and can distinguish the state it exists to detect.
- [ ] A fixed regression leaves a layer 1 guard behind, and `docs/TESTING.md` has its row.
- [ ] A new rail is a checkable precondition, not "never do X" prose.
- [ ] Any new failure mode states which direction it fails toward, and why.
- [ ] An absent signal is not treated as a passing one — no empty rollup, missing conclusion, or exit code read as success.
- [ ] A derived fact is resolved, not inferred from a path or a label.
- [ ] A file an adopter copies alone has no relative imports and works on Windows.
- [ ] No inline `--body "..."` carrying markdown or fences — written under `.temp/` and passed as `--body-file`.
- [ ] New paths are reflected in `ARCHITECTURE.md`, and shipped files reference only shipped paths.
- [ ] Every comment added explains why, not what.
- [ ] `node scripts/checks.mjs` passes locally before pushing.
- [ ] Commit subjects are `#<issue> <imperative lowercase>`, under 80 characters, no trailing period.
