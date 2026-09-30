# Skill generation — the derivation recipe

Read this from `/port:analyze`'s step 6.5. It exists as its own file so `SKILL.md` states only the load-bearing refusals and stays well under the file-size limit — the same progressive-disclosure split `skills/pipeline/TICK-PROSE.md` already uses for the cockpit.

## What port owns versus what the repository owns

Port maintains exactly three things: the two archetype templates (`${CLAUDE_PLUGIN_ROOT}/templates/SCAFFOLDER.template.md`, `${CLAUDE_PLUGIN_ROOT}/templates/AUDITOR.template.md`), this derivation recipe, and a static check that a generated skill parses. Port does **not** maintain a catalogue of finished, stack-specific skills — that is the shape this ticket exists to avoid (the same generality test the engineering standards apply elsewhere: a library of ready-made skills selected by detected stack would be one set per stack combination, maintained centrally, contradicting the repository's own principle that everything is per-repository).

The filled skill is the adopting repository's file the moment it is written. It lives under `.claude/skills/`, travels with the repository, and is editable by the operator like any other file they own. Port never reads it back except to diff it on a re-run (see "Re-running" below).

## The two archetypes, and when each applies

**Scaffolder** — creates a unit of work correctly, following this repository's own conventions. Applies when the repeated evidence is *structural*: the same kind of file, created the same way, more than once. `allowed-tools: Read, Grep, Glob, Write, Edit` — it writes the new files.

**Auditor** — checks an existing area against a standard. Applies when the repeated evidence is a *rule* already approved in `docs.engineering` or `docs.design` that nothing mechanical enforces yet. `allowed-tools: Read, Grep, Glob` — it reports; it never edits, which is why `Write`/`Edit` are absent from its `allowed-tools`, not an oversight.

A candidate that is neither — a one-off, or something already mechanically enforced — is not a skill. Saying so, with the reason, is a correct outcome (see "Presenting and writing" below).

## Evidence thresholds

Two hard numbers, one per archetype. Neither condition alone is enough for either archetype.

**Scaffolder:** the unit of work exists at least **three** times in the codebase, and the three most recent instances agree on structure. Fewer than three instances, or three that disagree on shape, is not a skill — a disagreement is a **flagged inconsistency** for step 3 of the main analyze flow, which is where it already belongs. Manufacturing a rule from one or two examples is inventing a convention, not observing one.

**Auditor:** an approved rule in `docs.engineering` or `docs.design` that is **not** already enforced by `commands.checks`, a linter, or the type-checker, **and** shows up in step 1's churn data or in the existing standards document's own warnings. A rule nobody has ever gotten wrong, or one CI already blocks on, does not need a skill watching for it too.

## The five rejection gates

Applied **in this order** to every candidate. Each is a hard no, with the reason recorded in the report (step 8):

1. **Covered by a plugin** installed or recommended in step 6. A real plugin beats a generated skill — that ordering is why this phase runs after the plugin search, never before it.
2. **Already enforced mechanically** — `commands.checks`, a linter, or the type-checker already catches this. A skill duplicating a mechanical check adds nothing and can drift from it.
3. **Under the evidence threshold** — fewer than three consistent instances for a scaffolder, or an auditor rule that fails either half of its threshold.
4. **Name collision.** The candidate's directory name collides with a skill under `${CLAUDE_PLUGIN_ROOT}/skills/` (this plugin's own shipped skills) or with an existing entry in the repository's own `.claude/skills/`. **Read both directories at generation time; never work from a transcribed list of shipped skill names** — a hard-coded list needs its own pin and goes stale the moment port adds a skill.
5. **The generic test — the central gate.** If the skill's body would still be true, word for word, in a different repository using the same framework, it is stack documentation, not a repository-specific skill, and it is dropped. This is the failure mode the whole ticket exists to avoid: a plausible-looking generic skill is worse than nothing, because it carries the authority of having been generated *for this repository* while contradicting how this repository actually works. Apply it last, after the others, because a candidate can pass every mechanical gate above and still fail this one on judgment alone.

## Filling a template

Every rule written into a generated skill cites the file (or files) it came from — the same "observed" discipline `/port:analyze`'s step 2 already applies to the standards documents. A rule with no citation is dropped, not softened into a guess or written as if it were self-evidently true.

For a **scaffolder**: cite the three instances named in the provenance line for "Follow these examples", and cite each entry in "Rules the examples do not show" to whichever `docs.engineering`/`docs.design` section states it, or to the file it was observed in when no section covers it yet.

For an **auditor**: cite the approved rule's section under "What to check", and name in "What this does not check" whatever `commands.checks`, a linter, or the type-checker already covers in the same area, so a reader never expects this skill to also catch that.

Delete every section either template has nothing true to say about, and delete the template's own instructional comment block once the skill is filled — it is not part of the generated skill.

## The frontmatter contract

`name` must equal the skill's directory name, and `description` must be non-empty — because a malformed skill is *absent* from the inventory, never reported as an error (the same "Component frontmatter is exact" rule the engineering standards state for this plugin's own components). `description` states the trigger condition in one sentence, because that sentence is what decides whether a model reaches for the skill at all.

`disable-model-invocation` is **omitted by default**. The point of a generated skill is reaching dispatched agents — the same delivery-surface reasoning step 6 already applies to recommended plugins — and an operator-invoked-only skill never reaches one. Set it `true` only for an operator workflow carrying side effects a model should never start on its own initiative, and record that reason in the file next to the setting.

## Pre-write validation

Run this on every proposed skill before it is written. A proposal failing any line is fixed or dropped — never written with a caveat attached:

- [ ] Frontmatter delimiters parse.
- [ ] `name` equals the target directory name.
- [ ] `description` is non-empty and states a trigger condition.
- [ ] `allowed-tools` is present, non-empty, and no wider than the archetype's default (`Read, Grep, Glob, Write, Edit` for a scaffolder; `Read, Grep, Glob` for an auditor).
- [ ] No name collision, checked by reading `${CLAUDE_PLUGIN_ROOT}/skills/` and the repository's own `.claude/skills/` directly.
- [ ] Every rule in the body carries a citation.

## Presenting and writing

**`git check-ignore -v .claude/skills` first** — the same config check step 3 of the main flow already runs. If the whole of `.claude/` is ignored, explain and write nothing:

> `.claude/skills/` is ignored by `.gitignore:<n>` (`.claude/`). A generated skill written there never reaches a dispatched agent's worktree, because worktrees carry only committed files. Narrow that rule to `.claude/settings.local.json` and `.claude/worktrees/`, then re-run this step. Nothing written.

Then **one confirmation per proposed skill**, showing the evidence that produced it — the cited files, and what nothing already covers it — before writing:

> **`scaffold-server-action`** — scaffolder. Three most recent instances agree: `<path>`, `<path>`, `<path>`. The rules it encodes: `<rule>`, `<rule>`, and `<rule>` — all cited to those files, none of them true of a generic repository on the same framework.
> Nothing covers this: no plugin from step 6 scaffolds this, and `commands.checks` does not enforce any of the cited rules.
> Writes `.claude/skills/<name>/SKILL.md`. Write it?

Report every declined candidate too, never silently — each with the gate that rejected it:

> **`<name>`** — dropped. `<gate and reason>`.

**Note `.claude/**` is in the default `sessionRequiredPaths`.** A later ticket editing a generated skill routes to `/port:implement` in an operator session, never to a dispatched agent — the same harness-level boundary that applies to any other `.claude/**` write.

**Nothing to generate is a correct outcome, not a failure** — state it plainly when every candidate was dropped:

> No skills generated. `<n>` candidates were considered and dropped — the reasons are above. This repository's conventions are either already enforced mechanically or not yet repeated enough to derive from, and a skill written from one example is boilerplate that carries authority it has not earned.

## Re-running

**Re-derive from the evidence the provenance comment records; diff against what is on disk; write only what is confirmed.** Port never tries to detect hand edits — it always diffs and always asks, so an operator's edits survive by being visible in the diff rather than by being protected from it:

> `<name>` has drifted. `<what changed in the evidence>`. Here is the diff against what is on disk — including any edits you made by hand, which I cannot distinguish from mine. Apply it?

A candidate whose evidence still supports it and whose on-disk file is unchanged needs no diff shown — say so and move on. A candidate whose evidence has fallen below its threshold since the last run is reported the same way a new decline is, never silently left in place.
