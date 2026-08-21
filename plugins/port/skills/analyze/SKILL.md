---
name: analyze
description: Read this repository and produce a real ENGINEERING.md — conventions inferred from the code, inconsistencies surfaced as decisions, improvements proposed for approval — then recommend stack-relevant plugins. Sets docs.engineering. Re-runnable as the codebase evolves. Manual only. Usage: /port:analyze
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Edit, AskUserQuestion, Bash(git log *) Bash(git ls-files *) Bash(git diff *) Bash(claude plugin list *) Bash(claude plugin install *) Bash(claude plugin marketplace list *) Bash(claude plugin marketplace add *)
---

# Analyze — generate this repository's engineering standards

**Trigger:** manual, or offered by `/port:init`. **Input:** none.

`docs.engineering` is the highest-leverage field in `.claude/port.config.json`: all four stage agents read it, and `review-agent` cites it as a review dimension. A repository with it null gets a pipeline working from the plan and the surrounding code alone. This skill is how it gets filled with something true.

**Expect this to be slow.** Reading enough of a codebase to say something accurate takes time, and the operator will be asked real questions. That is the cost of a document worth citing.

## Read the configuration first

Read `.claude/port.config.json` for `repo`, `docs.engineering`, and `commands`. If it is missing, stop — this repository is not port-managed, and `/port:init` comes first. If instead one exists at the repository root, say so and name the fix — move it under `.claude/`, or re-run `/port:init` — rather than reporting a repository that plainly is managed as unmanaged.

If `docs.engineering` is already set and that file exists, this is a **re-run**: see "Re-running" at the end before doing anything else.

## 1. Sample the codebase deliberately

Reading everything does not scale and is not necessary. Sample for *structure and convention*, not coverage:

- **Entry points** — routes, commands, or public API surface. These reveal the layering.
- **A few representative files per layer**, chosen from different features so a single author's habits are not mistaken for a convention.
- **Data access and schema**, wherever persistence is defined.
- **The authorization boundary** — where a request is authenticated and how access is scoped.
- **Configuration that already encodes rules** — linter, formatter, type-checker, and build config. A rule enforced by tooling is already settled; do not re-litigate it, but *do* record it.
- **Tests**, to infer what is actually tested and at what level.
- **History** — `git log --oneline -100` and the files that churn most. What keeps being changed is what keeps being got wrong.

Use Grep and Glob scoped to source directories. **Never descend dependency or build output directories.** Note what you sampled; the operator needs it to judge coverage.

Where `commands.checks` is non-empty, read what those commands enforce. A standard already checked by CI belongs in the document as an observed rule, not a proposal.

## 2. Build the rule set — three tiers, always visible

Every candidate rule is exactly one of these, and the tier determines what happens to it:

**Observed** — the code does this consistently. State it as the rule and **cite the files it was inferred from**. Evidence is what makes the document reviewable; an uncited assertion cannot be checked, and a reader has to take your word that the codebase does what you claim.

**Flagged** — the code does this *inconsistently*. **Never pick silently.** Record both patterns with their prevalence, and put the choice to the operator in step 3. An inconsistency resolved by coin-flip becomes a rule that review then enforces against half the codebase.

**Proposed** — the code does not do this and it would be an improvement. Each proposal is approved individually in step 3. Nothing aspirational is written unapproved, because the moment a rule is in this document, review starts citing it against pre-existing code and revise starts "fixing" working code to satisfy it.

Be honest about which tier something is in. Dressing a proposal up as an observation is the most damaging thing this skill can do: it makes the document look like a description of the codebase when it is a wish.

## 3. Integrate an existing document, then decide with the operator

**If a standards document already exists** — whether or not `docs.engineering` points at it — read it. It encodes decisions the code alone cannot reveal, and discarding it loses information no amount of reading recovers. For each of its rules:

- **Still matches the code** → carry it forward as observed, keeping its original wording where that wording is clearer than yours.
- **Contradicts the code** → this is the important case. **Propose a different rule and say why**, showing what the code actually does. A stale rule is worse than no rule: review will cite it, and revise will change working code to satisfy it.
- **Cannot be evaluated from the code** — a process or intent rule → carry it forward untouched. Absence of evidence is not contradiction.

**Then put the open questions to the operator**, using `AskUserQuestion`:

- Each **flagged** inconsistency: the two patterns, their prevalence, and which is the rule. Offer "leave it unspecified" as a real option — an undecided question is better recorded as undecided than resolved arbitrarily.
- Each **proposal**: what it is, why it would help, and what it would mean for existing code. Approve or drop, individually.
- Each **replaced** existing rule: the old rule, what the code does instead, and the proposed replacement.

Batch related questions rather than asking twenty times, but never bundle unrelated decisions into one answer.

## 4. Write the document

Follow the section structure in `${CLAUDE_PLUGIN_ROOT}/templates/ENGINEERING.template.md`. **Omit sections you have nothing true to say about** — an empty heading invites someone to fill it with something generic later, and review cites headings as if they carried rules.

Write it for the reader it actually has: a stage agent about to make a change, and a reviewer deciding whether a change is acceptable. So rules are specific and checkable. "Keep components small" is unusable; "route-specific components live beside their route, anything used twice moves to `components/`" is a rule an agent can follow and a reviewer can cite.

**Section 8, the pre-pull-request self-check, is the highest-value part of the document.** It is what implementation builds toward, what revision must not reintroduce, and what review uses as its dimensions. It must be derived from what actually recurs in *this* repository — the churn from step 1, what the linter keeps catching, what the existing document already warns about. **A generic checklist here is the main way this skill fails while appearing to succeed:** the document looks complete, and adds nothing.

Then set `docs.engineering` in `.claude/port.config.json` to the written path.

## 5. Recommend plugins for this stack

You now know the stack better than a keyword search ever could. Use it.

Configured marketplace catalogs are cached on disk at `~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json` — no network needed. Read them with the Read tool.

1. List the stack signals worth matching: language, framework, database, hosting, test runner, notable services.
2. Match against catalog `name` and `description` **with judgment**. Substring matching is not good enough — searching the official catalog for `next` returns an endpoint-security plugin and a courseware plugin, neither relevant. **If you cannot justify a recommendation in one sentence referencing what the analysis found, drop it.**
3. **Exclude anything already installed** (`claude plugin list`). Recommending what the operator already has reads as noise and costs their attention.
4. Present a handful at most, each with the specific evidence that motivates it. A list of twenty is the same as no list.
5. Ask which to install. **Install only explicitly-picked plugins, one confirmation each, at project scope:**

   ```bash
   claude plugin install <name>@<marketplace> --scope project
   ```

   If that marketplace is not already declared at project scope, declare it too, or a fresh clone will have an `enabledPlugins` entry it cannot resolve:

   ```bash
   claude plugin marketplace add <source> --scope project
   ```

6. Report what was installed and where it landed.

### Why project scope, not user

Both commands take `--scope user|project|local`. **Project is the right one here**, and the reason is mechanical rather than tidiness:

- **`project`** writes `enabledPlugins` and `extraKnownMarketplaces` into the repository's **committed** `.claude/settings.json`. Because it is committed, it travels into **dispatched agents' worktrees** — which is the entire point. These recommendations exist so the stage agents have better grounding in this stack; a plugin the agents cannot see does nothing for the pipeline. It also means a teammate gets the same tooling on clone.
- **`local`** writes `.claude/settings.local.json`, which is gitignored. Personal to this checkout, and **invisible to worktrees**, so the agents never see it. Offer it only if the operator does not want the choice committed, and say plainly that the agents will not benefit.
- **`user`** applies the plugin to every project on the machine. Wrong for a recommendation derived from analyzing *this* codebase — a database plugin picked for this repository has no business loading in an unrelated one.

**One portability caveat.** A marketplace whose source is a local directory records an **absolute path** in the committed settings, which will not resolve on anyone else's machine. Only declare a marketplace at project scope when its source is portable — a git or GitHub repository. For a directory source, install at `local` scope instead and say why.

**Never install anything unprompted.** Third-party plugin installation is a supply-chain decision, and at project scope it is also a committed change other people inherit. An agent making that call on its own initiative is the wrong default however good the recommendation is.

No marketplaces configured, or no relevant matches → say so in one line and move on. **Do not pad the list to look useful.**

## 6. Report

- The document written, and which sections were omitted for lack of anything true to say.
- Counts by tier: observed, flagged-and-decided, proposals accepted and dropped.
- Existing rules carried forward, and any replaced with what and why.
- Roughly what was sampled, so coverage is judgeable.
- Plugins installed and skipped, the scope each landed at, and that a project-scope install is a **committed** change to `.claude/settings.json` that teammates inherit.
- `docs.engineering` now set — and that review will cite this document from the next cycle onward.

If the operator abandons the run, **write nothing and leave `docs.engineering` as it was.** A half-approved document is worse than none, because the unapproved half is indistinguishable from the approved half once written.

## Re-running

The codebase evolves, so this is not one-shot. On a re-run:

**Diff against the existing document; do not regenerate from scratch.** Every rule in it was either observed or explicitly approved, and a regenerate-every-time skill silently discards decisions the operator already made — the exact failure the approval step exists to prevent.

Present only what changed: rules the code no longer follows, new conventions that have emerged, and proposals now worth revisiting. Leave everything else untouched, including wording.
