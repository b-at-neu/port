---
name: analyze
description: Read this repository and produce a real ENGINEERING.md — conventions inferred from the code, inconsistencies surfaced as decisions, improvements proposed for approval — and a DESIGN.md when the repository has a real interface, then recommend stack-relevant plugins from the local, org, and public catalogs. Files findings as tickets rather than fixing them. Sets docs.engineering and docs.design. Re-runnable as the codebase evolves. Manual only. Usage: /port:analyze
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Edit, AskUserQuestion, WebSearch, WebFetch, SearchPlugins, Bash(git log *) Bash(git ls-files *) Bash(git diff *) Bash(git rev-parse *) Bash(git check-ignore *) Bash(gh issue create *) Bash(claude plugin list *) Bash(claude plugin details *) Bash(claude plugin install *) Bash(claude plugin marketplace list *) Bash(claude plugin marketplace add *) Bash(claude plugin marketplace update *)
---

# Analyze — generate this repository's engineering standards

**Trigger:** manual, or offered by `/port:init`. **Input:** none.

`docs.engineering` is the highest-leverage field in `.claude/port.config.json`: all four stage agents read it, and `review-agent` cites it as a review dimension. A repository with it null gets a pipeline working from the plan and the surrounding code alone. This skill is how it gets filled with something true.

**Expect this to be slow.** Reading enough of a codebase to say something accurate takes time, and the operator will be asked real questions. That is the cost of a document worth citing.

## You do not change code. Ever.

**The only four things you may write are the engineering document, the design document, `.claude/port.config.json`, and the skills generated under `.claude/skills/` in step 6.5.** Everything else in the repository is read-only to you, however obvious a fix looks and however small.

This is not merely scope. A fix made here has no plan, no review, no pull request, and no approval gate — it bypasses the entire mechanism the pipeline exists to provide. This skill is the one part of the system that runs *outside* the pipeline, which makes it exactly the wrong place to change code. When you find something worth fixing, it becomes a ticket in step 7, and the pipeline does it properly.

You hold `Write` and `Edit` because the files above need them. That means this restriction is an **instruction, not an enforcement** — the tools cannot be scoped to a path that is itself configurable. Follow it as a rule, the same way the stage agents follow "write files with the tools" as a convention rather than a guarantee.

## Read the configuration first

Read `.claude/port.config.json` for `repo`, `docs.engineering`, `docs.design`, `branches.integration`, and `commands`. If it is missing, stop — this repository is not port-managed, and `/port:init` comes first.

If `docs.engineering` or `docs.design` is already set and that file exists, this is a **re-run**: see "Re-running" at the end before doing anything else.

**Also note the current branch** (`git rev-parse --abbrev-ref HEAD`) against `branches.integration` — step 6 reuses it to caveat a project-scope install made off that branch.

## 1. Sample the codebase deliberately

Reading everything does not scale and is not necessary. Sample for *structure and convention*, not coverage:

- **Entry points** — routes, commands, or public API surface. These reveal the layering.
- **A few representative files per layer**, chosen from different features so a single author's habits are not mistaken for a convention.
- **Data access and schema**, wherever persistence is defined.
- **The authorization boundary** — where a request is authenticated and how access is scoped.
- **Configuration that already encodes rules** — linter, formatter, type-checker, and build config. A rule enforced by tooling is already settled; do not re-litigate it, but *do* record it.
- **Interface evidence** — the manifest's UI framework or renderer dependency, component/template/view files, stylesheets, and any **declared token source** (a Tailwind config, a theme file, token JSON, CSS custom properties, a component library's theme). Same scoped-Grep-and-Glob rule; never descend build output.
- **Tests**, to infer what is actually tested and at what level.
- **History** — `git log --oneline -100` and the files that churn most. What keeps being changed is what keeps being got wrong.

Use Grep and Glob scoped to source directories. **Never descend dependency or build output directories.** Note what you sampled; the operator needs it to judge coverage.

Where `commands.checks` is non-empty, read what those commands enforce. A standard already checked by CI belongs in the document as an observed rule, not a proposal.

**Classify the interface — three ways, never as a boolean** — `none`, `thin`, or `real` — from the evidence just gathered, and **report the evidence with the classification** so the operator can overrule it:

- **`none`** — no UI framework in the manifest, no component or template files, no stylesheets. Report it, no question asked, and move on: no design document, and `docs.design` stays null — one for a library or a CLI would be padding, and review would cite it anyway.

  > No user interface here: no UI framework in the manifest, no component or template files, no stylesheets. So no design document, and `docs.design` stays null — one for a library or a CLI would be padding, and review would cite it anyway.

- **`thin`** — some interface, but real rules would be sparse (a handful of component files, little or no stylesheet, no declared token source). Present the evidence with an honest recommendation to skip, then ask via `AskUserQuestion` (header `Design document`):

  > Some interface, but thin: `<n>` component files, `<n>` lines of stylesheet, no declared token source. I could write a design document, but I have three or four real rules and would be padding the rest — and review cites every heading in it.

  - `Skip it` *(recommended)* — "`docs.design` stays null. Run `/port:analyze` again when the interface grows."
  - `Write it anyway` — "Only what is real goes in; expect a short document with sections omitted."

  Declining follows the same path as `none`.

- **`real`** — a genuine interface with enough surface to document. Proceed to the design phase (step 5.5) alongside the engineering phase, reading the token sources as values rather than inferring them.

  > Real interface: `<framework>`, `<n>` component files, tokens declared in `<path>`. I will read the token sources as values rather than infer them, and put anything inconsistent to you as a decision.

  An **undeclared-but-consistent palette or scale** is flagged the same way any inconsistency is, in step 3 — for example:

  > `<value>`, `<value>`, and `<value>` recur across `<file>` and `<file>`, and no custom property declares any of them. I can record them as **observed** — those are the values, cited to those files. Giving them names is a **proposal**, and only goes in if you approve it.

## 2. Build the rule set — three tiers, always visible

Every candidate rule is exactly one of these, and the tier determines what happens to it:

**Observed** — the code does this consistently. State it as the rule and **cite the files it was inferred from**. Evidence is what makes the document reviewable; an uncited assertion cannot be checked, and a reader has to take your word that the codebase does what you claim.

For design rules specifically, "observed" has **two shapes**, and both are cited to a file rather than inferred: a **declared** token — quote the value and cite the file that declares it (a Tailwind config, a theme file, a CSS custom property) — and an **undeclared but consistent** value — a literal that recurs across files with nothing naming it, quoted and cited to every file it recurs in, **without inventing a name for it**. "Introduce a token layer so these have names" is a **proposed** rule, approved individually like any other — design tokens are not always declared, and the undeclared-but-consistent shape is not an edge case.

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

## 4. Present the whole document for approval, before writing anything

**Writing is the last action of this phase.** Before it, show the operator the complete proposed contents: every rule, grouped by the section it will live in, each tagged **observed** / **flagged-and-decided** / **proposed-and-approved**.

Approving individual questions in step 3 is **not** approving the result. An operator who accepted three proposals in isolation has still never seen the document they are about to be held to — and from the next review cycle onward, every rule in it gets cited against their code.

So: present it, take edits, re-present if the changes are substantial, and only then write. **If the operator abandons at this point, write nothing** — not the document, not `docs.engineering`.

## 5. Write the document

Follow the section structure in `${CLAUDE_PLUGIN_ROOT}/templates/ENGINEERING.template.md`. **Omit sections you have nothing true to say about** — an empty heading invites someone to fill it with something generic later, and review cites headings as if they carried rules.

Write it for the reader it actually has: a stage agent about to make a change, and a reviewer deciding whether a change is acceptable. So rules are specific and checkable. "Keep components small" is unusable; "route-specific components live beside their route, anything used twice moves to `components/`" is a rule an agent can follow and a reviewer can cite.

**Section 8, the pre-pull-request self-check, is the highest-value part of the document.** It is what implementation builds toward, what revision must not reintroduce, and what review uses as its dimensions. It must be derived from what actually recurs in *this* repository — the churn from step 1, what the linter keeps catching, what the existing document already warns about. **A generic checklist here is the main way this skill fails while appearing to succeed:** the document looks complete, and adds nothing.

Then set `docs.engineering` in `.claude/port.config.json` to the written path.

## 5.5. Write the design document — a separate phase, not folded into step 5

**Only when step 1 classified the interface `real`, or `thin` and the operator chose "Write it anyway."** Skip this step entirely on `none`, or a declined `thin` — no design document, `docs.design` stays null, and step 8's report says so plainly. Keeping this its own phase, after the engineering document is already written, means abandoning here leaves the approved engineering document untouched:

> Nothing written, `docs.design` still null. The engineering document you approved earlier is untouched.

Build the design rule set the same way step 2 and step 3 built the engineering one — three tiers, an existing document integrated if one exists, open questions (including any undeclared-but-consistent palette or scale) put to the operator via `AskUserQuestion`. Then, mirroring step 4's guarantee, **present the whole design document for approval before writing anything**:

> Here is the complete design document, before anything is written. Every rule is tagged observed / flagged-and-decided / proposed-and-approved, and every observed value quotes its literal and cites the file it came from. `docs.design` is still null, and stays null unless you approve this.

Only once approved, write it — follow the section structure in `${CLAUDE_PLUGIN_ROOT}/templates/DESIGN.template.md`, the same "omit sections you have nothing true to say about" rule as step 5. **Section 7, the agent quick reference, is required, not optional** — the same reason `ENGINEERING.template.md`'s own §8 is required: it is what `plan-agent` reads to design a state and what `review-agent` cites, and a generic one is the main way this phase fails while looking complete.

Then set `docs.design` in `.claude/port.config.json` to the written path.

## 6. Recommend plugins for this stack

You now know the stack better than a keyword search ever could. Use it.

Aim for **coverage across the stack's domains**, not a fixed count: language and type tooling, framework, data layer, hosting, testing, and any notable service the code actually talks to. One good match per domain. For a rich stack that lands somewhere around 8–15; for a simple one, two or three is the correct answer.

There is deliberately **no cap**. Most plugins cost almost nothing to have installed — measured across a real set, `context7` is ~0 tokens always-on, `code-simplifier` ~64, and only skill-heavy plugins like `superpowers` (~688) or this one (~1,195) are meaningful. Breadth is cheap; irrelevance is not. So the filter is relevance, and it is this: **if you cannot justify a recommendation in one sentence referencing what the analysis found, drop it.**

### What counts as already covered

Exclusion means **already declared at project scope in this repository** — read `enabledPlugins` from `.claude/settings.json`, and from `.claude/settings.local.json` too (report anything found only there as local-only and invisible to worktrees). Nothing else counts. `claude plugin list` answers a different question — installed on this machine, not declared in this repository — and is never the exclusion source.

A plugin `claude plugin list` reports as installed, that `enabledPlugins` does not declare, is not excluded. It is a **declare-here candidate**, folded into the ordered list in "What to recommend" below and phrased as who else gets it once declared — a clone, and every dispatched agent's worktree, currently get none of it — never as "you already have this."

### Where to search — three tiers, all three every time

1. **Configured marketplaces.** **Refresh first** — `claude plugin marketplace update` — or you are searching however stale the last sync was. Then **Grep** the catalogs at `~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json`, using context to pull each entry's neighbouring fields. **Never read a catalog whole** (the official one is ~4,000 lines) and **never shell out to an interpreter or `jq` to filter it** — same rule the stage agents follow, for the same reasons.
2. **The claude.ai catalog**, via the `SearchPlugins` tool. It does **not** cover locally-configured marketplaces, so it is a genuinely separate source rather than a duplicate of tier 1. An empty result means this account has no organisation catalog — not that nothing exists.
3. **The wider internet**, via web search. Plugins and marketplaces not configured locally at all: search the detected stack terms alongside "Claude Code plugin" or "marketplace". Adding one is `claude plugin marketplace add <source> --scope project`, then installing from it.

**Tier 3 runs every time.** Codebase size and stack simplicity are never reasons to skip it — useful breadth follows the number of domains a repository touches, not how large it is, and tiers 1 and 2 systematically miss anything published outside the official catalog. The only acceptable non-run is a tool failure, reported as one (`tier 3: web search unavailable — <reason>`), never as "not needed." An empty result is one line: `tier 3: no relevant third-party marketplaces found.`

**Match with judgment, not substrings.** Searching the official catalog for `next` returns an endpoint-security plugin and a courseware plugin, neither relevant.

### What to recommend — does it reach a dispatched agent?

**Stage agents run autonomously. Nobody types a command at them.** A plugin whose value is a slash command an operator invokes helps the human in their own session — a different goal from helping the pipeline, worth recommending on its own merits but never sold as the same benefit.

| Component | Reaches a dispatched agent? |
| --- | --- |
| MCP server | Yes — appears as tools |
| LSP server | Yes — diagnostics surface while reading and editing |
| Hooks | Yes — run at the harness level |
| Skills | Yes — `Skill` is allowlisted for `plan-agent`/`review-agent`, and `impl-agent`/`revise-agent` declare no `tools:` restriction of their own, so the same allowlist entry reaches them too. A skill carrying `disable-model-invocation: true` never counts here, however it is packaged — it is an operator command. |
| Slash commands | No |

Order the recommendation list by this table — MCP and LSP first, passive skills second, operator-facing commands last, labelled `operator-facing` with a one-line statement that it helps the operator rather than the pipeline. To tell the groups apart: `claude plugin details <name>` reports a candidate's component counts, and a skill carrying `disable-model-invocation: true` is operator-facing regardless of what else the plugin ships. Fold each declare-here candidate from "What counts as already covered" into this same ordered list — it groups by delivery surface exactly like a fresh install.

Keep the one-sentence-justification filter and the no-cap rule: **if you cannot justify a recommendation in one sentence referencing what the analysis found, drop it** — breadth is cheap, irrelevance is not.

### Risk differs by tier, and you must say so

A plugin from the official directory has a known publisher. One from an arbitrary repository found by web search is **unvetted third-party code that will load in every session** — and because installs are project-scoped and committed, for everyone who clones the repository too.

So for tier 3, present the **provenance**: the repository, its owner, whether it looks maintained. Make the confirmation informed rather than a formality. **If provenance cannot be established, say so and recommend against it.**

### Installing

Ask which to install. **Install only explicitly-picked plugins, one confirmation each, at project scope:**

```bash
claude plugin install <name>@<marketplace> --scope project
```

If that marketplace is not already declared at project scope, declare it too, or a fresh clone will have an `enabledPlugins` entry it cannot resolve:

```bash
claude plugin marketplace add <source> --scope project
```

**A declare-here install verifies its own delta.** After installing one, re-read `enabledPlugins` and report whether the entry appeared: `` `context7` now in enabledPlugins `` or `` `enabledPlugins` unchanged — the install was a no-op at project scope; declare it by hand ``.

### Reporting

Report what was installed and where it landed — and that a newly installed plugin is not available in this session until a new one is started, with unresolving skills or commands as the symptom. **If any install landed at project scope and this checkout is not on the integration branch**, add:

> ⚠️ Installed at project scope on `<branch>`, not `<integration>`. A project-scope install is a committed change: it reaches dispatched agents only after it merges to `<integration>`, and only on a machine that already has the plugin cached. Merge it on its own ticket, and mark tickets that depend on it as blocked by it.

### Why project scope, not user

Both commands take `--scope user|project|local`. **Project is the right one here**, and the reason is mechanical rather than tidiness:

- **`project`** writes `enabledPlugins` and `extraKnownMarketplaces` into the repository's **committed** `.claude/settings.json`. Because it is committed, it travels into **dispatched agents' worktrees** — which is the entire point, **but only once this checkout's change merges to the integration branch**; worktrees are cut from there, not from whatever is on disk here. These recommendations exist so the stage agents have better grounding in this stack; a plugin the agents cannot see does nothing for the pipeline. It also means a teammate gets the same tooling on clone. A plugin addition is best treated as its own prerequisite ticket: land it on its own, and mark anything that depends on it as blocked by it.
- **`local`** writes `.claude/settings.local.json`, which is gitignored. Personal to this checkout, and **invisible to worktrees**, so the agents never see it. Offer it only if the operator does not want the choice committed, and say plainly that the agents will not benefit.
- **`user`** applies the plugin to every project on the machine. Wrong for a recommendation derived from analyzing *this* codebase — a database plugin picked for this repository has no business loading in an unrelated one.

**One portability caveat.** A marketplace whose source is a local directory records an **absolute path** in the committed settings, which will not resolve on anyone else's machine. Only declare a marketplace at project scope when its source is portable — a git or GitHub repository. For a directory source, install at `local` scope instead and say why.

**Never install anything unprompted.** Third-party plugin installation is a supply-chain decision, and at project scope it is also a committed change other people inherit. An agent making that call on its own initiative is the wrong default however good the recommendation is.

No marketplaces configured, or no relevant matches → say so in one line and move on. **Do not pad the list to look useful.**

## 6.5. Generate repository-specific skills, from archetypes

**Runs after step 6, never before it** — a real plugin beats a generated skill, so this phase only proposes what step 6 found nothing covers.

Port ships two archetype templates — a scaffolder and an auditor — and a derivation recipe; it does **not** ship a catalogue of finished, stack-specific skills. Read `${CLAUDE_PLUGIN_ROOT}/skills/analyze/SKILL-GENERATION.md` and follow it in full: the evidence thresholds, the five rejection gates (in order, the generic test last and load-bearing), the citation discipline for filling a template, the frontmatter contract, and the write procedure.

**Propose, never write unconfirmed.** One confirmation per skill, showing the evidence that produced it. **Proposing nothing is a correct outcome** — a repository whose conventions are either already mechanical or not yet repeated enough gets told that plainly, never padded with a generic skill to look useful.

Output lands in the repository's own `.claude/skills/`, never inside port — it travels with the repository and stays editable.

## 7. Offer to file the findings as tickets

The analysis will have surfaced work: inconsistencies worth resolving, places the code diverges from a rule that was just approved, gaps an accepted proposal implies. **Offer to write these up as issues.**

This is the right destination and the reason step "You do not change code" exists. A ticket enters the pipeline, gets a plan, gets reviewed, and lands as a pull request with an approval gate. **The analysis identifies work; the pipeline does it.** Fixing something here would skip all of that.

```bash
gh issue create --repo <repo> --title "<title>" --body-file .temp/finding-<n>.md
```

- **Offer, never create unprompted.** The operator picks which findings become tickets, one confirmation each.
- **Significant findings only.** A ticket per nit buries the two that matter — and an operator who gets twenty issues from one analysis will close them all unread.
- Each body stands alone: what the inconsistency is, where it shows (paths), and **which rule in the new document it relates to**. A finding that cannot name its rule probably should not be a ticket.
- Write bodies with the Write tool and pass `--body-file`, never inline — the same file-based GitHub I/O rule the rest of the harness follows.

## 8. Report

- The document written, and which sections were omitted for lack of anything true to say.
- Counts by tier: observed, flagged-and-decided, proposals accepted and dropped — for the engineering document, and separately for the design document when one was written.
- Existing rules carried forward, and any replaced with what and why.
- Roughly what was sampled, so coverage is judgeable.
- The interface classification (`none` / `thin` / `real`) and its evidence, and whether `docs.design` was set or deliberately left null — the skip is reported, never silent.
- Plugins installed and skipped, the scope each landed at, the **cumulative always-on token cost** of the set (from `claude plugin details`), and that a project-scope install is a **committed** change to `.claude/settings.json` that teammates inherit.
- Skills written and skills proposed-and-declined with the reason and the evidence each cited. These are **committed** files reaching dispatched agents only once they merge to `branches.integration`, and `.claude/**` in `sessionRequiredPaths` routes any later edit to `/port:implement` rather than a dispatched agent.
- `docs.engineering` now set — and that review will cite this document from the next cycle onward. Same for `docs.design`, when set: `docs.design` set to `<path>` — from the next cycle onward, plan designs interface work against it, implement builds to it, and review cites it as a dimension.

If the operator abandons the run, **write nothing and leave `docs.engineering` and `docs.design` as they were.** A half-approved document is worse than none, because the unapproved half is indistinguishable from the approved half once written.

## Re-running

The codebase evolves, so this is not one-shot. On a re-run:

**Diff against the existing document; do not regenerate from scratch.** Every rule in it was either observed or explicitly approved, and a regenerate-every-time skill silently discards decisions the operator already made — the exact failure the approval step exists to prevent. **A design document, if one exists, is diffed the same way** — re-derive it from scratch and every approved decision is lost.

Present only what changed: rules the code no longer follows, new conventions that have emerged, and proposals now worth revisiting. Leave everything else untouched, including wording.

**Re-classify the interface on every re-run**, even when `docs.design` is null. A repository that has grown a real interface since the last run — or the last decline — is offered the design document it previously skipped, using the same `none`/`thin`/`real` decision as step 1.
