# Output formats

Read alongside `PIPELINE.md`, not a standalone component — moved byte-identical out of it (#181). Defined once here; the stage agents follow these exactly.

### Writing style (every output)

Every plan, review, summary, and comment is written for a human scanning fast:

- **Bullets and short sentences over paragraphs** — one idea per bullet.
- **Never restate context the reader already has** (the ticket, a prior review, the diff) — reference it.
- **Omit empty sections** — no "N/A" or "None" filler; if a section does not apply, leave it out.
- **No meta-commentary** — do not describe the document itself.
- **Say it once** — never repeat a point across sections, or across body, inline, and summary.

### Implementation plan (`plan-agent` writes it into the issue body)

Appended below the ticket under a `---` then `## Implementation Plan`; revision mode replaces only that block. **Do not restate the ticket** — reference it. Fixed sections in this order; conditional ones appear **only when they apply**:

- **`SESSION REQUIRED` marker** *(only when a `sessionRequiredPaths` entry is touched)* — the plan block's first non-empty line, before `## Overview` (see "Detection").
- **## Overview** — 2–4 sentences: what, why, the approach.
- **## Changes** — a single fenced ` ```files ` block, one claimed path per non-blank line: `` path — one-line reason ``. The **path is the first whitespace-delimited token**; everything after the first space is a human-readable reason and is never parsed. Paths are repo-relative, forward-slashed, no leading `./`, case-sensitive. List **every** file the plan creates or modifies, including a new file at the path it will be created at — a `## Testing` step that writes a file is not a claim. **No globs** — a directory that will gain files whose names are not yet decided is listed once with a trailing `/`, which matches any path under it. Exactly one fence per plan; an absent or empty block means the plan dispatches unchecked, with a warning (see "File contention").
- **## Implementation** — ordered `- [ ]` checkboxes, one line each; fold validation, states, and error-model notes into the step they belong to.
- **## Data & contracts** *(only if a schema or a server-side contract changes)* — the change, and per entry point its validation and authorization.
- **## UX states** *(only if there is a user interface)* — loading, empty, error, plus key copy.
- **## Testing** — human-runnable manual steps as `- [ ]`, feeding the pull request's testing plan. A step whose only reachable path is `sessionRequiredPaths` and did not already trigger the whole-plan marker takes the form `- [ ] **operator-only** — <step> (<why>)`.
- **## Risks / notes** *(optional)* — only real, non-obvious ones.

Most plans fit on one screen. No preamble, no restated goal, no empty sections.

### Reviews and revisions

The code review is a **real GitHub pull request review** (`gh api …/pulls/<pr>/reviews --input`): **inline line comments carry the findings**; the body is a one-line verdict. **Event:** `COMMENT` when the reviewer is the author (common case — same account; GitHub forbids `REQUEST_CHANGES`/`APPROVE` on your own pull request), otherwise `REQUEST_CHANGES` or `APPROVE`. The pipeline **label** is the real control signal regardless.

**Findings live on the threads, not in a summary.** A resolved review thread *is* the log entry — collapsed and out of the way until expanded. So a finding is never re-narrated cycle after cycle, and "what is still open" is GitHub's unresolved-conversation count.

- **Review body = title plus one line.** `## Code Review — Cycle <n> · <verdict>`, `<verdict>` one of `approved`, `needs revision`, or `blocked — checks pending` (keep the literal `Code Review` — the cockpit counts it), then a single counts line, e.g. `2 open — 1 🔴 Critical, 1 🟠 Medium (see inline)`. Nothing else. **Only exception:** a finding that cannot anchor to a diff line has no thread, so it goes in the body with a `blob/<headRefOid>` permalink.
- **Each finding is one inline comment** on a diff line: `**R<n>-<sev><id>** <emoji> — <problem>. Fix: <one line>.` Stable ID `R<cycle>-<sev><id>`; severities 🔴 Critical · 🟠 Medium · 🟡 Low · ⚪ Nit. Inline comments are **new actionable findings only** — never status.
- **Escalating bar — what blocks rises with the cycle.** Pass 1 polishes everything, later passes converge: **cycle 1** any finding blocks; **cycle 2** Low and above (Nit does not); **cycle 3+** Critical and Medium only. A nit introduced during a revision cannot re-trigger at cycle 2 or later. The cockpit's cap is `reviewCycleCap` cycles, **unconditional** — it fires whatever the latest verdict said, which routes to `needs human`. A red required check, other than the `## Check evidence` carve-out, is **always** Critical, at every cycle — never downgraded to fit a later cycle's bar.
- **Inline anchoring.** A comment is accepted only on a line **in the diff** — map it from `gh pr diff` hunk headers (added and context lines → `side:"RIGHT"`, new-version line; deletions → `side:"LEFT"`, old-version line). If the reviews API returns 422 for an unresolvable line, **resubmit with `comments:[]`** and list those findings in the body with permalinks, so a review always lands.
- **Revision resolves threads, it does not summarize.** After pushing fixes, for each **fixed** finding reply `Fixed in <sha>` on its thread and resolve it via GraphQL (`addPullRequestReviewThreadReply` then `resolveReviewThread`), matched by ID; **genuinely-skipped** threads get a one-line reason and stay open. Then one short comment per cycle, or none: `## Revision — Cycle <n>` plus a single line `fixed <ids> · skipped <ids> · <sha>`, appending `· rebase: <file> (<strategy>)` if a conflict was auto-resolved. The detail line may instead open `check <name> · <sha>` for a check-fix cycle — see `revise-agent.md` step 1 — with no `fixed`/`skipped` segment, since there are no threads to resolve.
- **Other comments** — `## Pipeline Escalation` (revise: ambiguous rebase), `## Blocker` (impl: on the issue), `## Gate cleared` (cockpit: on the pull request, at `unblock #N`), `## Approval withdrawn` (cockpit: on the pull request, when a check goes red after approval — see "The `<labels.approved>` carve-out" in `## Check evidence`), and `## Rebase required` (cockpit or `review-agent`: when `mergeable` reads `CONFLICTING` — see "Rebase required" below) stay short: what is blocked/cleared/withdrawn/needed and the decision required, via `--body-file`.

### Approval withdrawn (cockpit writes it via `--body-file`)

Posted the same tick the cockpit routes an approved pull request back to `<labels.needsRevision>` per the `## Check evidence` carve-out. Short, no restated context:

```
## Approval withdrawn
`<check-name>` went **<conclusion>** on `<head-sha>` after approval. <link>
```

Names the check, its conclusion, its link, and the head SHA the conclusion belongs to — the four facts that authorise the removal, so the record stands on its own without the cockpit's own reasoning attached.

### Rebase required (cockpit and `review-agent` write it via `--body-file`)

Posted whenever `mergeable` reads `CONFLICTING` — at the cockpit's dispatch gate, at its approved re-verify, or at `review-agent`'s own exit — the moment a pull request is labelled `<labels.refreshBranch>` for this reason. Two lines, no restated context:

```
## Rebase required
Conflicts with `<base>` at `<head-sha>` — GitHub can't build a merge ref, so no checks ran on this diff.
```

Names the base branch and the head SHA the conflict was read against — enough for `revise-agent` to enter refresh mode (see `revise-agent.md`) without re-deriving anything, and enough for a human reading the thread to know the pipeline never had checks to go on.

### Pull request description (`impl-agent` writes it via `--body-file`)

`Closes #N` · **## Summary** (what was built and the approach) · **## Changes** (notable files and areas) · **## Testing plan** — reproducible **manual** steps as a `- [ ]` checklist a human runs before merge, covering happy path, error and empty and edge cases, and any authorization roles, derived from the issue's testing section · **## Automated checks** (the `commands.checks` that were run) · **## Notes** (schema changes, risks, follow-ups).

Any `- [ ] **operator-only**` step in the issue's `## Testing` carries into `## Testing plan` **verbatim** — the prefix is the only thing telling the human which box only they can tick.

The pull request is **assigned to the issue's assignee**, falling back to `@me` when the issue has none — never a hardcoded login. The pull-request-stage queries are assignee-filtered too, so a pull request with the wrong owner is invisible to the cockpit that shepherded its issue.

### Commit messages

Write the message to `.temp/commit-msg.txt` and `git commit -F .temp/commit-msg.txt` — **never** inline multi-line `-m … -m …`, which collapses on Windows and drops the subject and co-authorship. Format: subject `#N <imperative lowercase summary>` **under 80 characters, no trailing period**; an optional short body only when the *why* is not obvious (blank line, wrap around 72, a few lines at most); then a blank line and the co-authorship trailer naming the model from `models`.
