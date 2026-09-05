---
name: release
description: Cut a release end to end — work out the next version from what has merged since the last release and confirm it with the operator, open the release pull request with a ticket-led changelog, then watch for it to merge (the moment the release actually ships) and draft a GitHub release and tag as changelog and provenance, with short user-facing notes, approval-gated. Manual only. Usage: /port:release
disable-model-invocation: true
allowed-tools: Read, Edit, Write, AskUserQuestion, ScheduleWakeup, Bash(git *), Bash(gh *)
---

# Release — cut a version

**Trigger:** manual. **Input:** none — the version is always derived from repository state.

**Requires `modules.release`.** If `.claude/port.config.json` sets it false, say the repository has no release flow configured and stop.

## Read the configuration first

Read `.claude/port.config.json` for `repo` (`<repo>`), `branches.integration` (`<integration>`), `branches.production` (`<production>`), and the `release` block: `versionSource`, `versionFiles`, and `versionCommand`.

**`branches.production` is `null` → stop and report, verbatim:** `branches.production is null — this repository has one long-lived branch, so there is nothing to promote into and modules.release is off. Nothing was changed.` An **absent** key is not this case — it still means the documented `main` default, and only an explicit `null` states single-branch mode (#54).

**`versionSource` changes the shape of this flow, so resolve it before anything else:**

- **`tags`** — git release tags are the only record of the version. There is no file to bump, so **Part 1 is skipped entirely** and a release is one pull request.
- **`package`** — a manifest in the repository carries the version, so the flow opens a **bump pull request first**, which rides into the release.

If `versionSource` is `package` but `versionFiles` is empty, **stop and report** — that combination cannot be executed, and guessing a manifest path would produce a wrong commit.

## What it does (one invocation, end to end)

You run this **once**. It then:

1. **Works out the version** — gathers everything merged since the last release, computes the candidates, recommends one with its reasoning, and asks you to confirm.
2. Opens the **release pull request** (`<integration>` → `<production>`), preceded by a **bump pull request** when `versionSource` is `package`.
3. **Watches** — re-checking on its own schedule via `ScheduleWakeup` — until you merge the release. That merge is the moment the release actually ships; you never re-run it.
4. Once merged, drafts short **user-facing** release notes as changelog and provenance, **gets your approval**, and creates the GitHub release and tag.

It is **state-driven**: every run, including each self-scheduled wake-up, re-resolves the version and phase from the remote and the open pull requests, then continues from wherever things stand. If a session ends, invoking `/port:release` again resumes cleanly.

## What actually delivers the release

Phase B creates a tag and a GitHub release. By itself, that **distributes nothing**.

Where consumers resolve a git ref — the default for a plugin marketplace source, which never consults releases or tags automatically — **the merge of the release pull request into `<production>` is the delivery**, carrying the version bump with it. Every consumer tracking `<production>` with `autoUpdate` gets the change on their next session, whether or not Phase B ever runs.

Two consequences follow, stated once so nothing downstream re-derives them:

- The window between merge and publish is **not** a staging window.
- `<production>` must be releasable at every moment, since the merge — not the tag — is what ships.

A repository that instead publishes a distributed artifact from Phase B still reads correctly: the framing above is about what consumers resolve, not about this repository's particular arrangement.

## 0. Preflight (every run)

```bash
git fetch origin
git rev-parse --verify origin/<integration> origin/<production>
git rev-parse --abbrev-ref HEAD
```

Both branches must exist. Record the working tree's entry ref, **`<entry-ref>`**: if `rev-parse --abbrev-ref HEAD` prints `HEAD`, the checkout is detached, so record `git rev-parse HEAD` (a SHA) instead. **`/port:release` leaves the working tree on the ref it found it on — every run, every wake-up** (see Part 1 and Guardrails).

## 0.5 Resolve the version (every run)

**One release is in flight at a time.** Take the first case that matches — in 1–4 a release already exists, so its version is adopted and nothing is asked:

1. **An open bump branch** *(`package` only)* — `git ls-remote --heads origin "bump/v*"`. The branch is deleted when its pull request merges, so its presence means in flight; the version is its `v<X.Y.Z>` suffix. **More than one match → stop and report**; releases do not overlap.
2. **An open release pull request:**

   ```bash
   gh pr list --repo <repo> --base <production> --head <integration> --state open --json number,title --jq '.[0]'
   ```

   Parse `Release v<X.Y.Z>` from the title. If it was renamed and does not parse, fall back to the version carried on `origin/<integration>`.
3. **A merged release, not yet published** — if the version on `origin/<production>` has no corresponding `gh release view v<version>`, that is the version → Phase B.
4. **A bump already merged into the integration branch** *(`package` only)* — if `origin/<integration>`'s version differs from `origin/<production>`'s, the integration branch carries a bump whose branch is gone and whose release pull request was never opened: a run that died between the two parts. Adopt that version → Phase A, skipping Part 1. **Without this case a fresh cycle would prompt for a version that can diverge from the one already committed.**
5. **None of the above** → a fresh cycle. Go to "Fresh cycle"; that is the only place a version is ever asked for.

Reading the current version depends on `versionSource`: for `package`, `git show origin/<branch>:<first versionFiles entry>`; for `tags`, the latest release tag with its `v` stripped.

Wake-ups always land in cases 1–4, so they never re-prompt.

## State detection (every run — pick exactly one phase)

```bash
gh release view v<version> --repo <repo>
gh pr list --repo <repo> --base <production> --head <integration> --state all --json number,state,title
```

- Release `v<version>` **already exists** → **Done.** Report the URL and stop.
- `<production>` is at `<version>`, or the release pull request is **MERGED**, and no release exists → **Phase B (publish).**
- A release pull request is **OPEN** → **Wait.** Skip Phase A, go straight to "Watch for the merge".
- The release pull request was **CLOSED unmerged** → **stop and report**; the release was abandoned.
- Otherwise → **Phase A (open the pull requests).**

## Gather merged work

The version recommendation and the changelog are built from this **one** list. Run it **once per invocation** and reuse the result.

1. **Range — resolved in order, first match wins:**

   ```bash
   gh release list --repo <repo> --limit 1 --json tagName --jq '.[0].tagName'
   ```

   1. **A previous published release exists** → `<prev-tag>..origin/<integration>`, deliberately *not* `<production>..<integration>`. The production branch carries release-merge commits that were never part of a published release, so **the tag is what "since last time" actually means.**
   2. **No previous release, and `git merge-base --is-ancestor origin/<production> origin/<integration>` exits 0** → `origin/<production>..origin/<integration>`. With no release ever cut, `<production>` cannot carry release-merge commits, so the objection that motivates the tag-based range above does not exist yet.
   3. **No previous release and production is not an ancestor** (empty, unrelated, or diverged history) → the full history of `origin/<integration>`. State which of the three cases was hit rather than falling through silently.

   ```bash
   git log --oneline --no-merges <range-from-above>
   ```
2. **Empty → stop:** `Nothing to release — <range used> has no commits.` Name the range actually used (it may be a tag range, a production-branch range, or full history), never a hard-coded `origin/<production>`. Never prompt for a version with nothing to release.
3. **Extract every `#<n>`** from the subjects — the commit convention is `#<n> message`. The log is `--no-merges` deliberately: under a merge-commit convention the ticket number already lives on the branch commits, and the merge subject (`Merge pull request #<n>`) would only duplicate it under a different, unrelated number; under a squash convention the squash commit is itself a non-merge commit and is already covered. Do not "fix" this by dropping `--no-merges`. Deduplicate, newest first.
4. **Resolve every number with two bulk calls, issued once per invocation:**

   ```bash
   gh pr list --repo <repo> --state merged --limit 200 --json number,title,author,labels --jq '[.[] | {number, title, login: .author.login, bot: .author.is_bot, labels: [.labels[].name]}]'
   gh issue list --repo <repo> --state all --limit 200 --json number,title,labels --jq '[.[] | {number, title, labels: [.labels[].name]}]'
   ```

   GitHub shares one number space between issues and pull requests, so `#<n>` in a commit subject is an **issue** number under a `#<n> message` convention and a **pull request** number under a `… (#<n>)` squash convention. Each extracted number resolves from exactly one of the two maps, so the pair covers both conventions without knowing which one is in use.

   - **Sizing:** start at `--limit 200`. If a map's lowest returned number is still above the lowest extracted number, the window was too short — re-issue **that one call once** at `--limit 500`, and stop there.
   - **Fallback, explicitly bounded:** a number in neither map gets a single per-item lookup (`gh pr view <n>` / `gh issue view <n>`), capped at **10 lookups per invocation**. Past the cap, remaining entries keep their commit subject and the skill states how many it did that for. The cap is the point — an unbounded per-item fallback is the defect this step removes.
   - **Classification:** keep `{number, title, labels, isBot}`. A **dependency-bot** entry is one that is `bot: true` in the pull request map, or carries a dependency-related label in either map. An entry that only appears in the issue map is never dependency-bot. A commit with **no** `#<n>` that is not a merge becomes a numberless entry keeping its subject.

## Fresh cycle — propose the version

Only when 0.5 reached case 5.

1. **Gather merged work** — this both feeds the recommendation and short-circuits on an empty release.
2. **Current version** — the latest release tag with `v` stripped; with no releases, whatever `versionSource` says.
3. **Compute the three candidates** — at `1.4.3`: major `2.0.0`, minor `1.5.0`, patch `1.4.4`.
4. **Pick a recommendation** from the labels already gathered:

   | Signal across the gathered tickets | Bump |
   | --- | --- |
   | Any new user-facing capability, or an enhancement label | **minor** |
   | Only fixes, dependency bumps, documentation, tooling, or chores | **patch** |
   | A breaking change | **major** — offered, never recommended |

   **Never recommend major.** Unless the repository has an explicit breaking-change signal — a label, a `!` in commit subjects, a `BREAKING CHANGE` trailer — inferring one is guessing. An unlabelled pull request counts as patch work; the operator can still choose minor.

5. **Ask** with `AskUserQuestion`, recommendation **first**:
   - Option labels are the computed numbers with the bump kind: `1.5.0 — minor (recommended)`, then the other two.
   - Each description carries **the reasoning and the tickets behind it** — e.g. "#364 and #367 add new capability; the other 9 are fixes and dependency bumps".
   - The major option says plainly that **no breaking-change signal was found**, so it is only for a deliberate choice.
   - A free-form answer is a **custom version** — the way to reach a prerelease such as `1.5.0-beta.1`. Strip a leading `v`, trim, and require `X.Y.Z` optionally followed by a prerelease. If it does not parse, **stop and report**.

## Phase A — open the pull requests

Guard: only run Phase A if the working tree is clean (`git status --porcelain` empty) and the gather was non-empty. If the tree is dirty, **stop** — commit or stash first.

### Part 1 — bump pull request

> **Only when `versionSource` is `package`.** With `tags` there is no version file, so skip straight to Part 2.

**Skip entirely** if `origin/<integration>` is already at `<version>` — the bump has merged. **If `bump/v<version>` already exists on origin**, do not recreate or re-commit it: open its pull request if it lacks one, then continue to Part 2.

**Invariant: `/port:release` leaves the working tree on `<entry-ref>` — restore before anything else runs, and assert rather than assume.**

1. **Detach onto the current integration branch**, so the bump rides into the release without a local branch surviving the run:

   ```bash
   git checkout --detach origin/<integration>
   ```

   **Detached, not `-b`:** no local `bump/v<version>` branch survives, so a retry after a failed push cannot collide with a stale local one — case 1 in "Resolve the version" (an open bump branch on origin) stays the single source of truth for in-flight state.
2. **Write the version.** If `versionCommand` is set, run it with `{{version}}` substituted — it must not commit or tag. Otherwise edit each entry in `versionFiles` directly with the Edit tool, changing only the version field. **Never hand-edit unrelated lockfile entries.**
3. **Commit and push the bump to a remote branch**, no local branch involved. Write `.temp/commit-msg.txt` with the Write tool, exact subject `bump version to v<version>`, including the co-authorship trailer, then:

   ```bash
   git add <versionFiles>
   git commit -F .temp/commit-msg.txt
   git push origin HEAD:refs/heads/bump/v<version>
   ```

4. **Restore the entry ref, then assert it:**

   ```bash
   git checkout "<entry-ref>"
   git rev-parse --abbrev-ref HEAD   # if <entry-ref> is a SHA, run `git rev-parse HEAD` instead
   ```

   The result must equal `<entry-ref>` (or, if `<entry-ref>` was a SHA, `git rev-parse HEAD` must equal it). **If it does not, stop and report loudly** — name both refs and the branch the operator must return to. A silent mismatch is the whole defect this restores.
5. **Restore on failure too.** If the edit, commit, or push fails, restore `<entry-ref>` first and report second — never end a turn detached or on `bump/v<version>`.
6. **If the restore itself fails** because `versionCommand` left artifacts outside `versionFiles`, **stop and report** the dirty paths and `<entry-ref>` — never `--force` the checkout, which would discard the operator's files to satisfy this invariant.
7. **Open the bump pull request** against `<integration>` unless one is already open, with a one-line body via `--body-file`.

### Part 2 — release pull request

The body is **minimal**: short bullets, **ticket number first**. No paragraphs, no per-change detail.

1. **Take the gathered list.** Per entry, the title is the entry's title (pull request title, or the issue's when resolution fell back to the issue map) with a leading `#<n> ` and any conventional prefix stripped. Dependency-bot entries go in their own section; everything else, numberless entries included, goes in **Changes**.
2. **Build the body** at `.temp/release-pr.md`, one short line per bullet, omitting the dependency section when empty:

   ```
   ## Release v<version>

   ### Changes
   - #169 short description
   - #153 short description

   ### Dependencies
   - #115 some-package → v10

   ### Testing plan
   - [ ] <something a user does> → <what they should see>
   ```

   Write **2–10** testing bullets, scaled to the release's size and risk. Every bullet is a **user-facing functional test** — an action a person actually performs, with its expected outcome. **Never** include build, lint, type-check, or "checks pass" bullets; automated checks already ran, and listing them crowds out the manual verification that has not.

3. **Open or update the release pull request.** An integration-to-production pull request is long-lived, so reuse an open one rather than opening a second:

   ```bash
   gh pr list --repo <repo> --base <production> --head <integration> --state open --json number --jq '.[0].number'
   ```

   None open → `gh pr create --repo <repo> --base <production> --head <integration> --title "Release v<version>" --body-file .temp/release-pr.md --assignee "@me"`. One open → `gh pr edit <n> --repo <repo> --title "Release v<version>" --body-file .temp/release-pr.md`.

   **The title must keep the `Release v<version>` form** — case 2 above reads the version back out of it.

**This pull request carries no pipeline labels**, so the approval gate does not apply to it. That is deliberate: the gate is scoped to the integration branch precisely so releases are not blocked by it.

Then tell the human once: merge the bump pull request first if there is one, then the release pull request — and that you will watch and publish automatically. Fall through to the wait.

## Watch for the merge

You cannot finish until the human merges. Poll on a schedule rather than blocking:

1. `gh pr view <release-pr-number> --repo <repo> --json state,mergedAt --jq '{state,mergedAt}'`
2. **`MERGED`** → Phase B.
3. **`CLOSED`** unmerged → stop and report; the release was abandoned.
4. **`OPEN`** → call **`ScheduleWakeup`** with a delay of about 120 seconds, `prompt` set **exactly** to `/port:release` so the wake re-enters this skill and re-detects state, and a reason naming the pull request being watched. Then **end the turn.** Do not spin in a loop or block waiting.

## Phase B — publish the release and tag

Runs once the production branch is at `<version>`. These notes are **shorter than the release pull request's**: single plain-language bullets, **only what a user would care about**. Exclude all behind-the-scenes work — dependency bumps, pipeline, tooling, CI, docs, refactors, chores. No ticket numbers.

1. **Confirm state.** `gh release view v<version>` must not exist. If the production branch is not at `<version>` yet, go back to the wait — **never publish early.**
2. **Find the previous release** for the range: `gh release list --repo <repo> --limit 1 --json tagName --jq '.[0].tagName'`.
   - **A previous release exists** → the range is `<prev-tag>..origin/<production>`, unchanged.
   - **No previous release** — this is the first release, so full history of `origin/<production>` is not the fallback here either: read the merged release pull request's own body instead — `gh pr view <release-pr-number> --repo <repo> --json body` — and distil the user-facing bullets from the changelog already there. It is the same set of changes, already computed in "Gather merged work" and already reviewed by the operator at merge. Full history of `origin/<production>` remains the last-resort fallback only if that body cannot be read.
3. **Gather user-facing changes.** With a previous release, the same extraction as before with `origin/<production>` in place of the integration branch. With none, distil from the release pull request body per the previous step. **Keep only user-visible features and fixes.** When unsure whether a change is user-relevant, **leave it out** — these notes are for users, not maintainers.
4. **Draft the notes** to `.temp/release-notes.md` — bullets only, each short and in plain language. **The last bullet is always exactly `- Minor enhancements and bug fixes`.** No heading; the release title is the version. If nothing is user-facing, that single bullet stands alone.
5. **Get approval — required before creating anything.** Present the drafted notes verbatim and apply any edits, re-showing them. **Do not run `gh release create` until the human explicitly approves.**
6. **Create the release and tag**, which creates `v<version>` at the production branch's head:

   ```bash
   gh release create v<version> --repo <repo> --target <production-head-sha> --title "v<version>" --notes-file .temp/release-notes.md --latest
   ```

   Read the SHA with `git rev-parse origin/<production>` as its own command and substitute the literal value — **never `$(...)` command substitution**, which is not allowlisted and would silently produce an empty argument.
7. **Handoff:** report the release URL.

## Guardrails

- **Never push to `<production>` or `<integration>` directly**, never run `gh pr merge`, and never create a tag by hand. The tag is created only by `gh release create` in Phase B, only after approval.
- **`/port:release` leaves the working tree on the ref it found it on — every run, every wake-up.** Restore `<entry-ref>` before anything else runs and assert the restoration; never end a turn detached or on `bump/v<version>`.
- **The version prompt happens at most once per release cycle.** An in-flight bump branch or release pull request is a release to *continue*, never an error.
- **Phase B never publishes without explicit human approval of the notes.**
- The wait is driven by `ScheduleWakeup` re-entering this skill; you invoke it only once.
- File-based bodies and notes only — never inline `--body`/`--notes` for multi-line markdown, since escaping breaks cross-platform.
- If anything is ambiguous — dirty tree, missing branch, nothing to release, pull request closed unmerged, two bump branches, an unparseable custom version, `package` with no `versionFiles` — **stop and report** rather than guessing.
