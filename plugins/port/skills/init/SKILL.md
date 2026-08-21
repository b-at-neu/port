---
name: init
description: Install the port agent pipeline into this repository — detect its toolchain, choose which subsystems to enable, write port.config.json, merge the permission lists into .claude/settings.json, create the label vocabulary, optionally install the CI merge gate, and offer to generate engineering standards from the codebase. Idempotent; nothing is written without confirmation. Manual only. Usage: /port:init
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(gh label *) Bash(gh api repos/*) Bash(gh repo view *) Bash(git branch *) Bash(git remote *) Bash(git rev-parse *)
---

# Initialize a repository for the port pipeline

Run this once, from inside the repository you are adopting.

**This skill exists because a plugin cannot ship permission rules.** `permissions.allow` and `permissions.deny` live only in user or project settings; a plugin's own settings file supports just a couple of unrelated keys. But that allowlist *is* the pipeline's safety model — stage agents run `permissionMode: dontAsk`, which auto-denies anything not allowlisted, so without it installed **no agent can do anything at all**. Installing it is load-bearing, not convenience.

## Ground rules

- **Nothing is written without confirmation.** This touches permissions, CI, and repository labels — all things the operator should see before they change.
- **Idempotent.** Re-running reconciles rather than duplicating: no doubled permission entries, no duplicate labels, no second copy of the workflow.
- **Report honestly.** Say what changed, what was left alone because it already existed, and what the operator must still do themselves.
- **Never invent configuration.** If detection cannot determine something, ask. A guessed check command produces an agent that fails every run for a reason nobody can see.

## 0. Pre-flight

```bash
git rev-parse --show-toplevel
gh repo view --json nameWithOwner,defaultBranchRef
```

Stop if this is not a git repository, or has no GitHub remote.

If `.claude/port.config.json` already exists, this is a **reconcile**: read it, say so, and ask whether to continue. Do not silently overwrite an existing configuration.

**If a `port.config.json` exists at the repository root instead**, it predates the move into `.claude/`. Migrate it with `git mv port.config.json .claude/port.config.json` so history follows the file, say that you did, and continue as a reconcile from the migrated config. Nothing reads the root location any more, so leaving it there would silently break every agent.

## 1. Detect

Gather, without writing anything:

- **Branches** — `git branch -r`. Look for an integration branch distinct from the default. If only one long-lived branch exists, say so; the pipeline needs an integration branch, and creating one is the operator's decision.
- **Toolchain** — read the manifest and lockfiles the repository actually has, and list the available scripts. **Do not assume a package manager**; a repository may have none.
- **Existing checks** — read `.github/workflows/` to see what CI already runs. A check the pipeline runs locally should match something CI enforces, or the agent's green run means nothing.
- **Branch protection** — `gh api repos/<owner>/<name>/rulesets`. An empty result is the common case and drives the `approvalGate` default below.
- **Existing labels** — `gh label list`, so the report can distinguish created from already-present.
- **Existing settings** — `.claude/settings.json` if any, to merge rather than replace.

Report what you found before proposing anything.

## 2. Choose the modules

Ask about each `modules` flag with `AskUserQuestion`, presenting the detected default as the recommendation and stating what the flag actually does.

| Flag | Recommend | Because |
| --- | --- | --- |
| `approvalGate` | **off** when no ruleset protects the integration branch | The check would never be required, so the workflow is pure noise. Say plainly that with no ruleset the gate is advisory either way. |
| `previewDatabase` | **off** unless the repository's previews demonstrably hold a per-pull-request database branch from a finite pool | It is a narrow situation, and enabling it makes the pipeline treat a red deployment as infrastructure rather than a bug. |
| `release` | on | Most repositories want an integration-to-production promotion flow. |
| `scope` | on | Cheap, and only used when invoked. |

The answers decide which of the remaining steps run at all.

## 3. Write `.claude/port.config.json`

From `${CLAUDE_PLUGIN_ROOT}/templates/port.config.json`, filled in with the detected values and the module choices, written to `.claude/port.config.json`. Show it in full and confirm before writing.

**First, check the path is not ignored:**

```bash
git check-ignore -v .claude/port.config.json
```

If it is ignored, **stop and explain** rather than writing it. The config has to be committed: it travels into dispatched agents' worktrees, and an ignored one means every agent reports the repository as unmanaged and halts. Tell the operator which `.gitignore` rule is responsible — `check-ignore -v` names the file and line — so they can narrow it. A repository that ignores all of `.claude/` usually wants to ignore `settings.local.json` and the worktree root, not this.

Set `docs.engineering` to a path only if that file **exists and says something real**. Leave it null otherwise — pointing it at an empty skeleton makes review cite a document with no content. Step 8 offers to fill it properly, and sets the field itself if the operator accepts.

Validate the result against `schema/port.config.schema.json` if a validator is available; at minimum confirm it parses and that `repo` matches the detected remote.

## 4. Merge the permission lists

Read `${CLAUDE_PLUGIN_ROOT}/templates/permissions.base.json` and merge into `.claude/settings.json`:

- Substitute `{{integration}}` and `{{production}}` into the push-deny rules, and `{{packageManager}}` into the package-manager entries. **If the repository has no package manager, drop those entries** rather than leaving a literal placeholder — an unsubstituted pattern matches nothing and silently grants nothing.
- Append `extraAllow` to the allow list.
- **Union with what is already there. Never drop an existing entry**, even one that looks redundant; it may be load-bearing for something outside the pipeline.
- Deduplicate exact repeats.

**Show the diff and confirm before writing.** This is the single most consequential file this skill touches.

## 5. Create the labels

Read `${CLAUDE_PLUGIN_ROOT}/templates/labels.json` and create the subset whose `module` is `core` or an **enabled** module. Use the configured name from `labels` where the repository overrode it.

```bash
gh label create "<name>" --color "<color>" --description "<description>"
```

**Leave same-named existing labels alone** — do not recolour or re-describe a label the repository already uses for its own purposes. Report created and skipped separately.

## 6. Install the CI gate

*Only when `approvalGate` is enabled.* Copy `${CLAUDE_PLUGIN_ROOT}/templates/approval-check.yml` to `.github/workflows/approval-check.yml`, substituting the integration branch, the marker and approved label names, and the blocking-label list (the in-flight and gate labels, one per line).

If the file already exists, diff it rather than overwriting, and ask.

## 7. Bootstrap ignores

Ensure `.gitignore` covers `.agents/`, `.temp/`, and the worktree root `.claude/worktrees/`. Append only what is missing.

## 8. Offer the codebase analysis

The repository is usable at this point, so this is the last thing asked and the only optional one.

`docs.engineering` is the highest-leverage field in the configuration: all four stage agents read it and `review-agent` cites it as a review dimension. `/port:analyze` fills it by reading the codebase and proposing standards — conventions inferred from the code, inconsistencies put to you as decisions, improvements approved individually. It also recommends plugins that suit the stack.

Ask whether to run it now.

- **Accepted** → read `${CLAUDE_PLUGIN_ROOT}/skills/analyze/SKILL.md` and follow it end to end. It writes the document and sets `docs.engineering` itself, so do not write either here. **Pass on what detection already found** in step 1 rather than making it re-derive the stack.
- **Declined** → leave `docs.engineering` null and **say what that means**: the stage agents will work from the plan and the surrounding code, and review will have no standards document to cite. Then note that `/port:analyze` can be run at any time.

**Declining is a genuinely supported path.** The analysis is slow and asks real questions, and an operator who just wants the pipeline running would rush exactly the decisions that matter most. State the consequence once and move on — do not press it.

## 9. Report, including what you did not do

Summarize: the config written, permissions added versus already present, labels created versus skipped, whether the workflow was installed, and files touched.

Then state the manual steps explicitly. Chiefly:

> **The approval gate is advisory until you make it a required check.** Add `run-approval-check` as a required status check in a branch ruleset on `<integration>`. I have not done this: it is an administrative change, hard to reverse, and it can block every merge if misconfigured.

Never let the operator walk away believing they have a merge gate they do not have. If `approvalGate` was left off, say that too — plainly, not as a footnote.

Also flag anything detection could not settle: no integration branch, no CI checks to mirror, an empty `commands.checks`. Finish with the next step:

> Start the cockpit with `/port:pipeline`, then say "work on #N" to opt a ticket in.
