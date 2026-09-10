---
name: pipeline-tick-prose
description: The prose tick procedure, refresh sweep, contention gate, zero-diff gate, liveness cross-check, cycle cap, and pacing ladder — followed when `commands.tick` is null. Moved byte-identical out of SKILL.md by #203; see PIPELINE.md → "Tick engine" for the boundary and why this fallback exists.
---

# Tick procedure (prose fallback)

Followed in place of `SKILL.md`'s "Tick procedure" section whenever `commands.tick` is `null` — the repository has not installed a tick engine, so every decision below stays a model judgment rather than a script's deterministic output. **Step 6 — Housekeeping** (worktree hygiene, and the denial/unowned/ungated/plugin-staleness reports) is unaffected either way and lives in `SKILL.md` itself, read alongside this document.

## Tick procedure

On start and on every wakeup, run one polling pass.

**Step 0 — read the resolved vocabulary.** Before the query below, Read `.temp/label-vocabulary.md`. If it is absent, or names a different `<repo>` than this session's, re-run Startup preflight's **Step 5 — label vocabulary** first. Every `labels: [...]` list and every `--jq` label comparison this tick is copied verbatim from that file — never retyped from the placeholders shown below, and never reconstructed from memory. Then Read `.temp/tick-state.md`; if it is absent or names a different `<repo>`, re-run Startup preflight's **Step 8 — tick state** first.

**An empty trigger set is never reported as "all clear" while the file's verdict is `unverified`, `mis-resolved`, or `partial`.** Say the queue could not be confirmed instead, and name the verdict — a blank result under any of those is at least as likely a resolution failure (or, for `partial`, a missing label for exactly the affected stage) as a genuinely empty queue. Once the verdict is `verified`, an empty result is trustworthy and reports normally.

**Step 0.5 — the resume line.** Before anything else in the tick, compare the `Date:` response header you are about to read (below) against `.temp/tick-state.md`'s `Last tick` + `Scheduled`. If the gap materially overshoots what was scheduled, emit the **Resumed after a gap** message (see UX states) before any other line — items may have changed unattended — and treat this tick as changed (reset the pacing ladder to the floor; see Pacing).

**One query, one round trip.** Write `.temp/tick-query.graphql` (Write tool — the aliases vary tick to tick, see below) and run it with `--include` so the response carries a `Date:` header, the only authoritative clock this session has (GitHub's schema exposes none, and no allowlisted command emits one):

```bash
gh api graphql --include -F query=@.temp/tick-query.graphql --jq '{data, errors, rateLimit: .data.rateLimit}'
```

The query is one `repository(owner:"<owner>", name:"<name>")` selection with one alias per set this tick needs, plus top-level `viewer { login }` and `rateLimit { cost remaining }` for the cost budget. Every connection carries `totalCount` beside `nodes`, and every issue/pull-request node carries `assignees(first:5){ nodes { login } }` — ownership is partitioned client-side now (see "Ownership is now enforced client-side" below), so **no alias filters by assignee**, unlike the old per-label REST calls. Aliases, unfiltered by assignee, `states: OPEN` on every connection:

- **6 trigger sets** — `ready`, `planChangesRequested`, `planApproved` (adds `body`), `readyForReview` (adds `mergeable`, `headRefOid`, `reviews(first:30){ nodes { body submittedAt commit { oid } } }` for the zero-diff gate below, and `comments(last:20){ nodes { body createdAt } }` for its `## Gate cleared` exception), `needsRevision` (adds `body`, `mergeable`, and `reviews(first:30){ nodes { body } }` for the cycle cap), `refreshBranch`. Read `rateLimit.cost` from the response after this widening rather than trusting the ~12-point figure below blindly — it is what the Cost budget paragraph already says to do, and the widened alias is exactly the kind of change that moves it.
- **4 gate sets** — `planReview` (adds `body`), `blocked`, `approved` (adds `headRefOid`, `mergeable`, and the latest commit's `statusCheckRollup` — see below), `needsHuman`.
- **5 in-flight sets** — `planning`, `inProgress` (adds `body`), `reviewing`, `revising` (adds `body`), `refreshing`.
- **`prOpened`** (adds `body`) — the whole unmerged-branch set for the file contention gate's occupied set, in the same call.
- **Module-gated** — `allOpenPRs: pullRequests(states: OPEN, first: 100){ nodes { number title labels(first:20){nodes{name}} assignees(first:5){nodes{login}} } }` under `approvalGate`, for the ungated sweep.
- **One `pullRequest(number: N)` alias per number in `.temp/tick-state.md`'s `Announced approved`** (`state`, `mergedAt`, `closed`, `headRefOid`, `mergeable`, `statusCheckRollup`) — the approved re-verify and merged-pull-request reconciliation, folded into the same call rather than a per-item `gh pr view` afterward.
- **`pluginRepo`, when Startup preflight step 4 resolved a staleness comparison target** — the same `ref(qualifiedName: "<target-ref>") { compare(headRef: "<installed-sha>") { behindBy } }` alias, recomputed every tick since the installed sha is fixed for the session but the target ref moves; see "Plugin staleness" under Housekeeping. Omitted for the rest of the session when step 4 found no computable target.

The `approved` alias's `statusCheckRollup` shape (and the per-announced-number aliases' too) is `commits(last:1){ nodes { commit { statusCheckRollup { state contexts(first:50){ nodes { __typename ... on CheckRun { name conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } }` — reduced per `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Check evidence" exactly as before, just already in hand instead of a follow-up `gh pr view`.

**Do not move `SESSION REQUIRED` detection into a `--jq` filter.** Keep `body` in the aliases that already carried it and read the literal substring from the Read/Write-tool-visible result, exactly as before — a bare-substring test folded into `--jq` is a different, weaker check than reading the field directly, and hardening that distinction is a separate ticket's job, not this one's.

**Failure is fail-closed on actions, never on reporting:**

- **`errors` present, `data` still present and usable** — treat only the aliases named in `errors[].path` as unavailable; emit the **Truncated alias** UX state for each. Never read an unavailable alias as empty.
- **No `data` at all** — a **blind tick**: emit the **Blind tick** UX state, dispatch nothing, run no hygiene, reset nothing, and still call `ScheduleWakeup` at the floor cadence (see Pacing). Never say "all clear" on a blind tick.
- **A connection's `totalCount` exceeds its `nodes` length** — that set is **truncated, not complete**: emit the **Partial response** UX state, act only on what came back, and never report that stage as empty.
- **The call errors outright (non-zero exit with no parseable JSON at all)** — same as no `data`: a blind tick.

**Cost budget.** ~12 points per tick against 5,000/hour — read the actual `rateLimit.cost` from the response rather than trusting this figure blindly. At the pacing floor (270s) that is well under 200 points/hour, so headroom is never a constraint at any rung of the ladder.

**Ownership is now enforced client-side.** Dropping the assignee filter from every alias is what makes the unowned sweep *derivable* rather than a separate `--search "no:assignee"` round trip — partition each set's nodes against `viewer.login` into **mine** (act on it), **another operator's** (skip, never act), and **unowned** (report via the Unowned report, never act). The rail is unchanged, only where it is enforced moved: **an item whose `assignees` do not include the viewer's login is never acted on, only reported.** Narrow the unowned partition to items carrying a trigger or gate label, so an unlabelled backlog item is not reported. The ungated sweep (`allOpenPRs`, under `approvalGate`) is filtered the same way it always was, by `--jq`-equivalent client-side filtering to pull requests carrying any pipeline stage label but **not** the resolved name for `<labels.marker>` — it was never assignee-filtered to begin with, since a worktree belongs to the checkout regardless of who owns the item.

Then, in this order. Steps 7 and 8 are split apart deliberately — they are the two that get skipped when folded into closing prose, so each is its own checkable action rather than a sentence:

1. **Reconcile merged pull requests.**
2. **Handle human gates.**
3. **Announce every session-required item.**
4. **Unless draining, dispatch** for every remaining actionable trigger item (all `Agent` calls in one message) — a pull request whose mergeability reads `CONFLICTING` is refreshed instead of reviewed; see "Refresh sweep". An issue at `<labels.planApproved>` whose plan claims enough non-shared files an in-flight item already claims is **held** instead of dispatched; see "File contention gate".
5. **Liveness cross-check** — call `TaskList` **first, unconditionally**, before anything else in this step (an empty in-flight set is not a reason to skip it — it is the case a stall is invisible in), then correlate the in-flight sets against its result and this session's own dispatch log (`.temp/dispatch-log.md`); auto-reset a dispatch this session provably lost, report every other case, and handle a usage-limit condition (see "Liveness" and "Agent questions and blockers" below).
6. **Housekeeping** — run worktree hygiene, then the denial, unowned, ungated, and plugin-staleness reports (only the ones whose sets changed since `.temp/tick-state.md`'s remembered sets). See `SKILL.md` → "Housekeeping" — this step is unaffected by `commands.tick` and is never moved here.
7. **Call `ScheduleWakeup`**, skipped only while draining. **A non-draining tick that ends without this call has failed**, no matter how much of the above happened.
8. **Write `.temp/tick-state.md` fresh** (Write tool) — `Last tick` and `Scheduled` from this tick's `Date:` header and the delay actually passed to `ScheduleWakeup`, plus the updated `Cadence step`, `No-change ticks`, `Denials consumed`, `Plugin staleness`, `Refreshed`, `Budget holds`, and the three remembered report sets.
9. **Only then, write the tick report.** Its closing "next tick" line is not a fresh decision — it is the record of step 7: state the delay you actually passed to `ScheduleWakeup`, or that you are draining and skipped the call. Never write this line before step 7 runs. **Every report carries a Liveness clause** naming the live agent count and each live agent's `description` (see UX states) — the number cannot be written without step 5's `TaskList` call, so its absence is what makes a skipped call visible to the operator, not just to this session.

**Never busy-wait inside a tool call.** The next tick is how this cockpit waits — never `sleep`, never `gh pr checks --watch`, never any chained wait. A check unconcluded this tick is re-read next tick, exactly as the approved re-verify already does; a wait burns the turn and the wall clock for a completion that arrives on its own anyway, since background-agent completions wake this session between scheduled ticks regardless.

**Merged-pull-request reconciliation (each tick).** The `approved` alias and the per-announced-number aliases are open-only, so a merged pull request silently drops out — **never trust in-session memory for "awaiting merge."** Diff `.temp/tick-state.md`'s `Announced approved` against the live result; for each number whose alias came back null or whose `state` is no longer `OPEN`, confirm from the same response (`state`, `mergedAt`, `closed` on that alias — no follow-up `gh pr view` needed) and announce it once. If merged or closed, announce it once, **remove it from `Announced approved`**, and reclaim its worktree (see "Worktree hygiene" below — one `<commands.worktrees> reclaim --issue <n>` call per confirmed number). This keeps `status` truthful without the human telling you.

**Mergeability gate (each tick, step 4, before dispatching review).** `readyForReview`'s alias already reads `mergeable` (see above) — no extra round trip. Branch on it per item, before deciding whether to dispatch `review-agent`:

- **`MERGEABLE`** — dispatch normally.
- **`CONFLICTING`** — do not dispatch review. Handled by the **Refresh sweep** below, not restated here.
- **`UNKNOWN`** — GitHub has not computed it yet (normal on a freshly opened pull request; the query itself is what triggers computation). Hold review one tick and report:

  > ⏳ PR #134's mergeability is still `UNKNOWN` — holding review one tick.

  On a **second** consecutive `UNKNOWN` tick for the same pull request, dispatch review anyway — `review-agent` re-checks mergeability itself before posting — and say so:

  > ⚠️ PR #134's mergeability is still `UNKNOWN` after two ticks — dispatching review anyway; it re-checks before it posts.

**Approved-and-conflicting is the same fact read at a different gate** — see "Approved pull requests" under Human gates and the **Refresh sweep** below; both routes handle it identically.

**Refresh sweep (each tick, step 4).** Replaces two ad-hoc branches — the mergeability gate above and the approved re-verify below both point here. Candidates: the union of `<labels.readyForReview>` ∪ `<labels.approved>` reading `mergeable: CONFLICTING` (both aliases already carry `mergeable` and `headRefOid` — no extra round trip). Process oldest pull request number first, up to the per-tick cap.

1. **Same-SHA guard** — never refresh a head SHA this session already refreshed. This pull request's `.temp/tick-state.md` `Refreshed:` entry (`#<pr>@<sha>×<count>`) recorded the same sha as the current `headRefOid`? Refreshing again would change nothing — **escalate instead**: add `<labels.needsHuman>` (drop `<labels.approved>` only if present — a stuck refresh loop is its own authorising fact), comment naming the stuck sha:

   > ⛔ PR #134 still reads `CONFLICTING` at `cb2dc1a`, which I already refreshed this session — a second refresh would change nothing. Escalated to `needs human`. Say `unblock #134` once you know why the rebase isn't clearing it.

2. **Otherwise, refresh it.** Write `.temp/rebase-required-<pr>.md` (`${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Rebase required"), comment it, then `gh pr edit <pr-number> --repo <repo> --add-label "<labels.refreshBranch>"` — **remove nothing** — and dispatch `revise-agent` in refresh mode this same tick. Update `Refreshed:`: carry the count forward (`+1`) when the prior sha moved via this session's own dispatch-logged refresh; otherwise (an outside push) reset it to `1`. Report, e.g.:

   > 🔄 PR #134 conflicts with `dev` — refreshing it (rebase + force-push) rather than calling it `needs revision`; nothing found anything wrong with it. It stays at `ready for review` and gets reviewed once the checks come back. (On an approved candidate, name why the approval survives: the approval stands, since a clean rebase doesn't change the diff that was approved; revision withdraws it only if the rebase has to resolve anything.)

3. **Bounds** — at most 3 consecutive refreshes per pull request: step 2's count reaching `4` escalates instead of refreshing again, same form as step 1; and at most 5 refreshes per tick, oldest first — any remainder waits for the next tick, reported (e.g. *"Refreshed 5 conflicting pull requests this tick … — 2 more are waiting and go next tick"*).

An entry is dropped from `Refreshed:` once its pull request reads `MERGEABLE`, since a refresh consumes no review cycle — see "Cycle cap".

**Zero-diff review gate (each tick, step 4, after the mergeability gate, before dispatching review).** A head a `## Code Review` has already been submitted against gets no second cycle — a clean review that keeps not merging (a liveness reset, an `## Approval withdrawn` bounce, a manual re-label) is otherwise invisible to both the cap above and to review itself, since neither compares the review's own commit against the current head. `readyForReview`'s alias already carries `headRefOid`, `reviews` (with `submittedAt` and `commit.oid`), and `comments` for exactly this (see the widened alias above) — no extra round trip. A `CONFLICTING` pull request is already handled by the Refresh sweep above and never reaches this test.

1. From the alias's `reviews`, take the newest node whose `body` starts with the literal `## Code Review` — the same predicate the cycle counter uses, so an empty drive-by review is never counted. **None** → dispatch.
2. Its `commit.oid` differs from `headRefOid` → **dispatch**. Real progress always moves the head.
3. Equal, **and** the newest `## Gate cleared` comment (from the alias's `comments`) is newer than that review's `submittedAt` → **dispatch, once**. The operator authorized this re-review through `unblock #N`; the next review resets the comparison by construction.
4. Otherwise → **do not dispatch**. Write `.temp/zero-diff-<pr>.md` — a `## Pipeline Escalation` body (the same heading `revise-agent`'s rebase escalation uses, with no `### D<n>` blocks, so `unblock #N`'s plain-clear path applies):

   ```
   ## Pipeline Escalation
   Cycle <n> already reviewed `<sha>` and the head has not moved, so no new review cycle was opened.
   Whatever is blocking this pull request is not visible to review or revision.
   ```

   then `gh pr comment <pr-number> --repo <repo> --body-file .temp/zero-diff-<pr>.md`, `gh pr edit <pr-number> --repo <repo> --remove-label "<labels.readyForReview>" --add-label "<labels.needsHuman>"`, and announce:

   > ⛔ PR #157 is at `ready for review`, but cycle 7 already reviewed `cb2dc1a` and the head hasn't moved — a new cycle would grade the same diff. Escalated to `needs human` and commented. If a check on that SHA has since changed, say `unblock #157` and choose **Back to review**; I'll dispatch one review against it.

**File contention gate (each tick, step 4, before dispatching `impl-agent`).** A `<labels.planApproved>` item dispatches only when no single in-flight item's plan claims `concurrency.overlapThreshold` or more of the same non-shared files — counted per in-flight item, never pooled. Full background: `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "File contention".

1. **Build the occupied set.** Union the `` ```files ``` `` block from every `<labels.inProgress>` issue's body and every open `<labels.prOpened>` issue's body (both aliases already carry `body` — no extra round trip), each path tagged with the item number and its label, excluding any path in `concurrency.sharedFiles` — a `sharedFiles` path is still claimed by its plan, only never contended. Parse per the grammar in `PIPELINE.md` → "Implementation plan": one path per non-blank line, the first whitespace-delimited token, a trailing `/` matching any path under it.
2. **Skip `SESSION REQUIRED` candidates** — those never dispatch here regardless (see Safety rails); they are never held either, since holding implies "dispatches once released" and these never dispatch.
3. **Plan carries no `## Changes` file block** — dispatch **unchecked**, once per item per session, since silently holding every unstructured plan (typically one written before this contract landed) would stall the pipeline harder than the collision this gate prevents. Warn:

   > ⚠️ #52's plan has no `## Changes` file block, so I can't check it for collisions — dispatching it unchecked.
4. **Depth at or above `concurrency.overlapThreshold` against one in-flight item's non-shared claims** → **hold**: do not dispatch — the item **keeps `<labels.planApproved>`**, since holding is never expressed by removing it and no label is ever added for it — and report every tick while it stays held, naming the depth:

   > ⏸️ **#52 held** — its plan and #67's (`pr opened`) both claim 2 files: `src/lib/auth.ts`, `src/lib/session.ts`. It dispatches automatically once #67's pull request merges or closes. Say `dispatch #52 anyway` to override.
5. **Below the threshold, or no overlap, after exclusions** → a survivor. Sort survivors ascending by how many *other survivors* they overlap at or above the threshold, after exclusions, and dispatch in that order, adding each dispatched survivor's claimed files to the occupied set as you go — a later survivor that now overlaps an earlier one's freshly-claimed files at or above the threshold is held this same tick, not dispatched. When the exclusion list or the threshold is what changed the outcome, report it once at dispatch — never for a candidate that never overlapped anything:

   > ▶️ Dispatching #52 despite overlapping #67 on `src/lib/registry.ts` (a `concurrency.sharedFiles` entry) — no contended files left, so this isn't a hold. With the threshold rather than the list doing the work: `… on 1 file (src/lib/session.ts), under the threshold of 2 — a rebase there resolves as a union.`

**Override taken ("dispatch #N anyway" / "force #N"):**

> ⚠️ Dispatching #52 despite the overlap with #67 on `src/lib/auth.ts`, at your instruction. Whichever lands second needs a rebase in that file, and it may be one `revise-agent` has to escalate.

**While draining, this gate computes nothing and reports nothing** — there is no dispatch to gate, so nothing is held.

**Liveness cross-check (each tick, step 5).** An in-flight label is a claim, never a heartbeat, and neither is its absence — a label is not evidence of liveness or of non-liveness. Call `TaskList` first, before reading anything else in this step, whether or not any set below is non-empty: the zero-agent case is exactly where a stall goes unnoticed, and it is the case a 96-tick session once sat in without ever making this call. Take the results of the five in-flight aliases above and match each item against that `TaskList` result by the dispatch `description`, which the harness records verbatim (`"<stage> #<n>"`, where `<n>` is the item's own number — a pull request for `review`/`revise`). **`TaskList` reports live agents only:** a finished agent is absent from it, never present with a finished state, which is why every class below infers termination from absence and why the budget sweep takes `--completed` from the relay loop instead. Before classifying, Read `.temp/dispatch-log.md` — the precondition for every reset below is **"reset only an item this session's own dispatch log records"**, never an item this session never dispatched.

**The tick report's Liveness clause is what makes the call checkable, not the sentence.** State the live agent count and each live agent's `description` — the same shape worktree hygiene already requires ("an adjective like *pruned* is never a sufficient report"). **A tick that reports on liveness without a `TaskList` call this tick has failed**, and an empty count is written as `**Liveness:** 0 agents live · no in-flight items` (see UX states), never omitted.

- **Matched, running** — nothing to do; it is genuinely mid-flight.
- **No match** — an in-flight label with no live agent, resolved against the dispatch log into exactly three outcomes. The invariant across all three: **at most one automatic reset per item per session** (the log's `Resets` column) — a crash loop reports instead of burning the session on repeated resets:
  - **Log row `State: dispatched`** (this session dispatched it, and this is the first unmatched tick) — rewrite its row to `State: suspect`, report it, change no label:

    > ⏳ #63 (`in progress`) has no live agent — confirming next tick before I reset it.

  - **Log row `State: suspect`, still unmatched, and `Resets: 0`** — provably dead: **reset**. Use the retry mapping (`planning`→`ready`, `in progress`→`plan approved`, `reviewing`→`ready for review`, `revising`→`needs revision`, `refreshing`→`refresh branch`), batched by (current → trigger) pair in one `gh issue edit` naming every number, pull requests one call each, then re-query to confirm every item moved. Rewrite the row to `State: reset`, `Resets: 1`. Dispatch is step 4 and liveness is step 5, so a reset item redispatches on the **next** tick, never this one — say so:

    > ♻️ **Reset 2 stalled items** — #63 (`in progress` → `plan approved`), PR #117 (`reviewing` → `ready for review`). I dispatched both this session and neither has a live agent. They redispatch next tick.

  - **No row at all** (a prior session's work, or another cockpit's) — this session cannot prove anything about it: **report-only, never touch**, every tick while the set is non-empty, as one grouped line:

    > ⚠️ **In flight with no dispatch record:** #66, #67 (`in progress`). I didn't dispatch these — a previous session or another cockpit did — so I won't touch them. Say `retry #66` to reset one.

  - **Already reset once this session and stalled again** (`Resets: 1` and still unmatched) — report, never reset a second time:

    > ⚠️ #63 stalled again after I reset it once this session — leaving it at `in progress`. Say `retry #63` for another attempt.

  Never reset `<labels.approved>` or `<labels.needsHuman>` — they are not in-flight labels, and nothing above ever matches them.

  **A `SESSION REQUIRED` item at an in-flight label is never reported as a stall.** `<labels.inProgress>` and `<labels.revising>`'s queries already carry `body` for exactly this: an item marked `SESSION REQUIRED` at its slot is the operator's own `/port:implement` session, not a stalled dispatch, and it can never have a dispatch-log row (this cockpit never dispatches one), so it is report-only by construction:

  > 🧰 PR #512 is `revising` under `SESSION REQUIRED` — that's your `/port:implement` session, not a stall.

- **Every in-flight item unmatched at once, and the most recent completion or error mentions a session limit** (a `"session limit"`/`"resets at"`-shaped message) — this is the **usage-limit** class, not ordinary stalling, and it takes precedence: when it fires, it has already reset everything and no per-item liveness reset above runs that tick. Reset each affected item's in-flight label back to its trigger label — group by (current label → trigger label) pair and issue one `gh issue edit` per group naming every number, pull requests one call each, then re-query to confirm — report the reset time verbatim from the message, and schedule the next wakeup for just after it — a small buffer past the reset, or the idle delay with a note if the time cannot be parsed. Never redispatch before it, and never substitute a different model to work around it.
- **`TaskList` cannot be correlated to numbers at all** (e.g. no `description` field surfaced) — report the in-flight set alongside the running-agent count and say the correlation is uncertain, rather than guessing which is which.

Full background: `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Liveness".

## Cycle cap (before every revise dispatch)

The `needsRevision` alias in the same tick query already carries `reviews(first:30){ nodes { body } }` — count the entries whose `body` starts with `## Code Review` from that, no follow-up `gh pr view`. Note that a refresh consumes no review cycle — refresh mode posts no `## Code Review` comment, so a pull request bounced through the Refresh sweep any number of times never advances this counter.

**The cap is unconditional** — at or above `reviewCycleCap`, escalate regardless of what the latest review found. At cycle 3+ a `<labels.needsRevision>` verdict reached *by a review finding* already implies Critical or Medium (the escalating bar), so a findings qualifier was redundant on the path it was written for, and unsatisfiable on every path that actually loops without one — `## Rebase required`, `## Approval withdrawn`, a liveness reset, or a manual re-label, all of which arrive here with a clean latest review. Write the note to `.temp/escalation-<pr>.md` with the Write tool — its `## Pipeline Escalation` first line names the cycle count and the cap (`<n> review cycles reached the cap of <reviewCycleCap> without merging`) and never claims findings are open, since under this rule there need not be any — then

```bash
gh pr edit <pr-number> --repo <repo> --remove-label "<labels.needsRevision>" --add-label "<labels.needsHuman>"
gh pr comment <pr-number> --repo <repo> --body-file .temp/escalation-<pr>.md
```

then notify the human.

## Pacing

**Step 7 of every non-draining tick** (see Tick procedure) is calling `ScheduleWakeup` with prompt `/port:pipeline`, before `.temp/tick-state.md` is rewritten and before the tick report is written. The predicate is **will any item move without human action this tick?**

- **Yes** — an agent in flight, or an item at a trigger label about to dispatch → **floor, ~270 seconds, no backoff ever.** Reset `Cadence step` and `No-change ticks` to `0`.
- **No** — everything outstanding is `<labels.approved>` awaiting merge, a plan-review gate, `<labels.blocked>`, `<labels.needsHuman>`, a held item, a `SESSION REQUIRED` item, or nothing at all → **advance the ladder one rung per consecutive no-change tick**, capped: `270 → 540 → 1080 → 1800`. Increment `No-change ticks` and `Cadence step` in `.temp/tick-state.md`.

**Reset to the floor immediately on any observed change** — a new trigger label, a merge, a completion, a gate answered, or the resumed-after-a-gap condition (Tick procedure, step 0.5). The reset is unconditional: even a tick that is otherwise "no-change" resets the ladder if anything changed since the last one.

**Never stop — a stopped cockpit is the only dispatcher, and a `ready` label applied while it is silent would never be picked up.** An hour-of-quiet shutoff was considered and rejected for exactly this reason: draining is the operator's own off-switch (see Stop controls), and nothing else should mimic it. The usage-limit carve-out (wake just after the reported reset time) is unchanged and overrides the ladder when it fires.

**The idle path is where the `ScheduleWakeup` call gets skipped, and it is the path that matters most.** With nothing in flight there are no agent completions to wake the session, so the scheduled wakeup is the *only* thing that catches a human applying a label on GitHub. An idle tick that ends in prose instead of the `ScheduleWakeup` call never ticks again — silently, and after telling the human it would.

**Self-check, every non-draining tick:** before ending the turn, confirm **both** `ScheduleWakeup` **and** `TaskList` were actually called this tick. If either was not, make that call now — do not write the closing line, or the Liveness clause it accompanies, first and let the sentence stand in for the call. **Carve-out:** this self-check applies to ticks, not to a refused or stopped start — a startup that fails the preflight schedules no wakeup, and that is correct, not a violation of this rule.

Close every non-draining tick's report with the delay you actually scheduled: `**Next tick:** ~1800s (scheduled)` or `**Next tick:** ~270s (scheduled)`, and the first tick each rung is newly reached, append the **Backing off** UX state's clause naming what is still outstanding. While draining, step 7 is skipped entirely (see Stop controls) and the closing line reads `**Next tick:** none — draining. Say "resume" to restart ticking.`

Background-agent completions wake this session automatically in between ticks; the scheduled wakeup is only the fallback that catches everything else. On every wakeup, run the tick procedure again.

**Worst-case pickup latency for a human label change rises from 4.5 to 30 minutes** in the fully-idle, fully-backed-off state, and only there — nothing can move without you at that point, and the moment you say anything or apply the label that unblocks it, the next tick resets to the floor. Not a stall.
