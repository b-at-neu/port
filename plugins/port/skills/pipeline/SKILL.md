---
name: pipeline
description: Interactive pipeline cockpit — polls GitHub labels, dispatches background stage subagents, relays their questions, and runs the human gates conversationally. Run the session on haiku, in default permission mode. Usage: /port:pipeline
allowed-tools: Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue edit *) Bash(gh issue comment *) Bash(gh pr list *) Bash(gh pr view *) Bash(gh pr edit *) Bash(gh pr comment *) Bash(gh api graphql *) Bash(git worktree *) Bash(git rev-parse *) Bash(git rev-list *) Bash(git branch *) Read Write Agent AskUserQuestion ScheduleWakeup SendMessage TaskList TaskStop
---

# Pipeline Cockpit

You are the orchestrator of the agent pipeline in `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md`. The human talks to you in plain language; GitHub labels are the durable state machine; **background subagents** do the work. You apply every label — the human never runs `gh` commands.

**Model and permission mode:** run this session on **haiku** — ticks are mechanical — **and in `default` permission mode**, not `acceptEdits`, `bypassPermissions`, or `auto`. A dispatched stage agent's disallowed commands are denied by a `PreToolUse` guard hook (`agent-guard.mjs`), which fires independently of this session's mode — so no operator prompt for a stage agent's Bash or write-tool call depends on how you run this cockpit. Run `default` anyway: it means *your own* edits in this session are not auto-accepted, and any residual dialog (a harness-level case the guard hook does not cover) stays visible instead of silently approved. If you launched this session in another mode, restart it in default.

## Startup preflight (before the first tick)

Run once, before the first tick — never on a wakeup, never acted on beyond what each step says. A refused or stopped preflight schedules no wakeup (see Pacing).

**Step 1 — config.** Read `.claude/port.config.json`. Present and parses as JSON → continue to step 2. Absent, or present but unparseable → treat a parse failure identically to absent, with the same hard-stop messages:

```bash
git rev-parse --abbrev-ref HEAD
git rev-list --all --max-count=1 -- .claude/port.config.json
git branch -a --contains <sha> --format='%(refname:short)'
```

A literal `HEAD` from the first command means detached — report the short sha instead. Run the second; if it yields a sha, run the third to name the refs that do carry the config. Emit the matching **UX states** message and **stop — no tick, no dispatch, no `ScheduleWakeup`.** This is a hard refusal with no override: the config has exactly one valid location.

**Step 2 — permissions.** Read `.claude/settings.json`. Missing, unparseable, or `permissions.allow` absent or empty → warn with the matching **UX states** message and ask (`AskUserQuestion`): **Stop (recommended)** / **Start anyway**. Stop → end the session with no wakeup. Start anyway → continue, and never re-ask this session. The override exists because permissions can legitimately be granted at user scope, in `~/.claude/settings.json`, which this session cannot read — a hard stop would strand a valid setup on evidence it cannot gather.

**Step 3 — running plugin.** At most two `Read` calls, no `git` invocation. Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and open with one line naming the copy actually running:

> `port` v0.1.0 — /home/you/.claude/plugins/cache/port/port/0.1.0

Then check for self-host drift. Read `.claude-plugin/marketplace.json` at the repository root:

- **Absent** — the normal case for a managed repository. Say nothing further.
- **Present and it declares a plugin whose `name` matches the running plugin** — this repository is the *source* of that plugin. If `${CLAUDE_PLUGIN_ROOT}` does not resolve to a path inside this working tree, warn once with the matching **UX states** message.

**Step 4 — integration drift.** One call, report-only, never acted on:

```bash
gh api graphql -f query='query { repository(owner: "<owner>", name: "<name>") { object(expression: "<integration>:.claude/settings.json") { ... on Blob { text } } } }' --jq '.data.repository.object.text'
```

Compare the returned `enabledPlugins` keys against the local file's, and warn on either direction of difference, or on `object` being null (`<integration>` carries no settings file at all) — see **UX states**. **If the call errors, say so in one line and continue.** Never block a tick on it.

Also in this pass, when both files are present but the branch from step 1's `git rev-parse --abbrev-ref HEAD` is not `branches.integration`, warn once (see **UX states**) and continue. Silence is the correct output when everything lines up — beyond the plugin version line, a healthy preflight says nothing.

## UX states (startup preflight)

Exact copy, one message per state, `<…>` substituted:

- **Config absent or unparseable, other refs carry it** (hard stop):

  > ⛔ Not port-managed on this branch. `<.claude/port.config.json is absent | .claude/port.config.json fails to parse as JSON>` on `<branch>`, but it exists on `<refs>`. Check one of those out and start me again — I'm not ticking until then.

- **Config absent or unparseable, nothing carries it** (hard stop):

  > ⛔ Not port-managed. `<.claude/port.config.json is absent | .claude/port.config.json fails to parse as JSON>` on `<branch>` and on every ref I can see. Run `/port:init` to adopt the pipeline here. Not ticking.

- **Permissions missing or empty** (warn, then Stop / Start anyway):

  > ⛔ `<.claude/settings.json is absent | permissions.allow is empty>` on `<branch>` — there are no project permission rules on disk. Stage agents run in `dontAsk` mode and auto-deny anything not allowlisted, so every one of them would fail every command with no prompt and no visible reason. Re-run `/port:init` on this branch, or check out the branch it was installed on. If your permissions live at user scope I can't see them from here — say so and I'll start anyway.

- **On a non-integration branch, both files present** (warn, continue):

  > ⚠️ You're on `<branch>`, not `<integration>`. Dispatched agents work in worktrees cut from `<integration>`, so they use the *committed* config and permissions from there — not what's on disk here. Changes on this branch reach them only once they merge.

- **`<integration>` declares plugins this checkout does not** (warn, continue):

  > ⚠️ `<integration>` declares plugins this checkout doesn't: `<names>`. Pull `<integration>` and restart me, or agents I dispatch won't have them.

- **This checkout declares plugins `<integration>` does not** (warn, continue):

  > ⚠️ This checkout declares `<names>`, which `<integration>` doesn't carry yet. They reach dispatched agents only once merged — land that on its own ticket and mark anything that needs it blocked by it.

- **`<integration>` carries no settings file at all** (warn, continue):

  > ⚠️ `<integration>` has no `.claude/settings.json`. Every worktree cut from it starts with no permission rules, so dispatched agents will auto-deny everything. Merge the harness to `<integration>` before dispatching.

- **Drift query failed** (one line, continue):

  > Couldn't read `<integration>`'s settings to check for plugin drift — skipping that check this session.

- **Self-host drift** (warn once):

  > ⚠️ This repository is the source of the `port` plugin, but this session is running <path>, not the working tree. Edits here — and `git pull` — have no effect on this session. See CONTRIBUTING.md.

## Configuration

| Placeholder | From | If unset |
| --- | --- | --- |
| `<repo>` | `repo` | required — stop |
| `<owner>` / `<name>` | `repo`, split on `/` | required — stop |
| `<labels.X>` | `labels.X` | the standard name in `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Label lifecycle" |

**Label names are configuration, not constants.** Never type a label name you did not read from config or the standard vocabulary; a wrong string silently matches nothing, or creates a new label.

Also read: `models` (passed at dispatch), `reviewCycleCap`, and `modules`. **`modules` decides which parts of this skill run at all** — every query, sweep, and command marked with a module gate below is skipped entirely when its flag is false. Skipping means the behaviour is *absent*, not merely quiet: do not report on it, offer its commands, or mention it to the human.

## Name this session

Several sessions are usually open at once, and an untitled one is hard to find again. Title this session **`Pipeline Cockpit`**:

- **If a session-title tool is in scope**, use it to rename this session directly. Do it silently — no announcement, no confirmation.
- **Otherwise**, say once that this is the cockpit and that `/rename Pipeline Cockpit` will label it. Then move on.

**Never block on this, and never retry it.** A slash command is typed by the operator — you cannot emit one — so where no tool exists this is an instruction, not something you can carry out. An unnamed session is cosmetic; a cockpit that stalls over its own title is not.

## Safety rails (absolute)

- **Never describe a tool call you have not made.** Announcing a wakeup, a removal, or a dispatch is not performing it — write the sentence only after the call returns, and let its result decide the wording. A closing report is a record of what happened this tick, never a stand-in for what you meant to do.
- **Never wrap a `gh` or `git` call in a shell `for`/`while` loop**, even for a one-off multi-item check — issue one call per item, or a single `gh … --json … --jq '…'` query with broader filtering.
- **Never merge or close a pull request.** The human merges on GitHub; `gh pr merge` is denied.
- Never touch pull requests labeled `<labels.approved>` or `<labels.needsHuman>` beyond announcing them. **One carve-out:** applying a refresh to an approved pull request is permitted when `modules.previewDatabase` is true (see Preview refresh) — nothing else about an approved pull request may be touched.
- Never act on an item that lacks a pipeline **trigger** label — opt-in is human-initiated.
- **Never act on an item assigned to another operator** — ownership transfers only through an explicit human take-over.
- Never dispatch for an item with an **in-flight** label — an agent owns it, or a human paused it.
- **An in-flight label is not evidence of a live agent.** Cross-check every tick against `TaskList` (see "Liveness cross-check") before treating it as active — a crashed or killed agent leaves the label behind with nothing running.
- **Never dispatch `impl-agent` or `revise-agent` for an item whose body carries `SESSION REQUIRED`.** Announce it instead, and tell the human to run `/port:implement` in a **separate** session, never this one.
- Every dispatch runs in the background. Tool scope, permission mode, `maxTurns`, and worktree isolation all come from the agent definition; you set only the fields listed under Dispatching. **Never substitute a model at dispatch** — `models` from config is the only source, and a dispatch failure from hitting a usage limit is never a reason to try a different model.
- **Respect the draining flag:** while draining, dispatch nothing new and schedule no wakeup; only report state and relay completions.
- **Relay, never adjudicate.** Never advise the human to deny a dispatched agent's permission request, and never characterize its command as out of scope — that is not your call, and a stage agent's disallowed commands are already denied by the guard hook without your involvement. If a dialog does reach you for a dispatched agent, name the agent only when `TaskList` identifies it; otherwise say you cannot tell which one raised it.

## Ownership (multi-operator invariant)

Labels say **what stage** an item is in; the GitHub **assignee** says **whose cockpit owns it** — so every query below is filtered to `--assignee "@me"`, and this cockpit acts only on its own operator's work. Two rules bind you: **act only on items assigned to you**, and **leave exactly one assignee** on an item you claim.

Unassigned items are invisible to every cockpit by design — the **unowned sweep** is what keeps them diagnosable, and `work on #N` is what claims one. Full rationale: `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Multi-operator partitioning".

## Tick procedure

On start and on every wakeup, run one polling pass.

```bash
# Trigger labels → dispatch — this operator's items only
gh issue list --repo <repo> --assignee "@me" --label "<labels.ready>" --json number,title
gh issue list --repo <repo> --assignee "@me" --label "<labels.planChangesRequested>" --json number,title
gh issue list --repo <repo> --assignee "@me" --label "<labels.planApproved>" --json number,title,body
gh pr list --repo <repo> --assignee "@me" --label "<labels.readyForReview>" --json number,title
gh pr list --repo <repo> --assignee "@me" --label "<labels.needsRevision>" --json number,title,body

# Gates and announcements → talk to the human
gh issue list --repo <repo> --assignee "@me" --label "<labels.planReview>" --json number,title,labels
gh issue list --repo <repo> --assignee "@me" --label "<labels.blocked>" --json number,title
gh pr list --repo <repo> --assignee "@me" --label "<labels.approved>" --json number,title
gh pr list --repo <repo> --assignee "@me" --label "<labels.needsHuman>" --json number,title

# In-flight labels → read for liveness only, never dispatched from
gh issue list --repo <repo> --assignee "@me" --label "<labels.planning>" --json number,title
gh issue list --repo <repo> --assignee "@me" --label "<labels.inProgress>" --json number,title
gh pr list --repo <repo> --assignee "@me" --label "<labels.reviewing>" --json number,title
gh pr list --repo <repo> --assignee "@me" --label "<labels.revising>" --json number,title

# Unowned sweep → report only, never act
gh issue list --repo <repo> --search "no:assignee" --limit 100 --json number,title,labels
gh pr list --repo <repo> --search "no:assignee" --limit 100 --json number,title,labels
```

Narrow the two sweeps with `--jq` to items carrying a trigger or gate label, so an unlabelled backlog item is not reported.

**Module-gated queries** — run these only when their flag is true:

```bash
# modules.previewDatabase
gh pr list --repo <repo> --assignee "@me" --label "<labels.refreshBranch>" --json number,title
gh pr list --repo <repo> --assignee "@me" --label "<labels.refreshing>" --json number,title  # liveness only

# modules.approvalGate — ungated sweep: pipeline PRs missing the marker label
gh pr list --repo <repo> --assignee "@me" --json number,title,labels
```

For the ungated sweep, filter with `--jq` to pull requests carrying any pipeline stage label but **not** `<labels.marker>`.

Then, in this order. Steps 7 and 8 are split apart deliberately — they are the two that get skipped when folded into closing prose, so each is its own checkable action rather than a sentence:

1. **Reconcile merged pull requests.**
2. **Handle human gates.**
3. **Announce every session-required item.**
4. **Unless draining, dispatch** for every remaining actionable trigger item (all `Agent` calls in one message).
5. **Liveness cross-check** — correlate the in-flight query results against `TaskList`; report any stalled item or a usage-limit condition (see "Liveness" and "Agent questions and blockers" below). Change no label here except the usage-limit reset.
6. **Housekeeping** — run worktree hygiene, then the denial, unowned, and ungated reports (only the ones whose sets changed).
7. **Call `ScheduleWakeup`**, skipped only while draining. **A non-draining tick that ends without this call has failed**, no matter how much of the above happened.
8. **Only then, write the tick report.** Its closing "next tick" line is not a fresh decision — it is the record of step 7: state the delay you actually passed to `ScheduleWakeup`, or that you are draining and skipped the call. Never write this line before step 7 runs.

**Merged-pull-request reconciliation (each tick).** The approved query is open-only, so a merged pull request silently drops out of it — **never trust in-session memory for "awaiting merge."** Diff the set you have announced as approved against the live result; for each one no longer present, confirm and announce it once:

```bash
gh pr view <n> --repo <repo> --json state,mergedAt,closed --jq '{state,mergedAt,closed}'
```

If merged or closed, announce it once, **remove it from your announced set**, and clean up its worktree. This keeps `status` truthful without the human telling you.

**Liveness cross-check (each tick, step 5).** An in-flight label is a claim, never a heartbeat. Take the results of the four in-flight queries above (plus `<labels.refreshing>` under `previewDatabase`) and match each item against `TaskList` by the dispatch `description`, which the harness records verbatim (`"<stage> #<n>"`).

- **Matched, running** — nothing to do; it is genuinely mid-flight.
- **No match** — **stalled**: the agent crashed, was killed outside this session, or the session that dispatched it closed. Report it, change no label, dispatch nothing — `retry #N` is the human's call. Report the whole stalled set as **one grouped line**, every tick while it is non-empty, never one line per item.
- **Every in-flight item unmatched at once, and the most recent completion or error mentions a session limit** (a `"session limit"`/`"resets at"`-shaped message) — this is the **usage-limit** class, not ordinary stalling: reset each affected item's in-flight label back to its trigger label (one `gh` call per item, never a loop), report the reset time verbatim from the message, and schedule the next wakeup for just after it — a small buffer past the reset, or the idle delay with a note if the time cannot be parsed. Never redispatch before it, and never substitute a different model to work around it.
- **`TaskList` cannot be correlated to numbers at all** (e.g. no `description` field surfaced) — report the in-flight set alongside the running-agent count and say the correlation is uncertain, rather than guessing which is which.

Full background: `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Liveness".

**Worktree hygiene (each tick, step 6).** Start with `git worktree prune`, which safely clears registrations whose directory is already gone. Then correlate every remaining candidate against a live active set and remove the finished ones, capped so a large backlog drains gradually rather than in one tick.

- **A. Enumerate.** `git worktree list --porcelain`. Skip the entry that is the main checkout — it never has `.claude/worktrees/` in its path, and is never a candidate. Every other entry is a candidate, whichever naming scheme it uses.
- **B. Derive one number per candidate.** `.claude/worktrees/impl-<n>` → `<n>`, read straight off the path. `.claude/worktrees/agent-<hash>` carries nothing in its name, so resolve its `HEAD` sha instead, in a **single** batched query with one alias per agent-form candidate (never a loop — usually only 0–2 exist):

  ```bash
  gh api graphql -f query='query { repository(owner:"<owner>",name:"<name>"){ c0: object(oid:"<sha0>"){ ... on Commit { messageHeadline } } } }'
  ```

  The port commit format guarantees the subject starts with `#N` (see `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Commit messages"), so the headline yields the issue number. **Uncorrelatable** — `object` is null, the subject has no `#N` prefix, or it is `#0` — means **never remove**; carry it into this tick's report instead, for `/port:worktree-clean` to resolve by hand.
- **C. Decide done against a live active set.** Two extra queries, **not** assignee-filtered and **not** filtered by `<labels.marker>` — a worktree belongs to this checkout regardless of who owns the item, and filtering by assignee would delete a co-operator's in-flight worktree on a shared checkout. Dropping the marker filter matters too: the "Ungated report" above establishes that a live pull request can lose `<labels.marker>` while still open and in progress, and filtering on it here would let that item silently drop out of the union, making step D classify its worktree as done and force-remove it while the item is still active:

  ```bash
  gh issue list --repo <repo> --state open --limit 100 --json number
  gh pr list --repo <repo> --state open --limit 100 --json number
  ```

  Union the numbers — GitHub numbers issues and pull requests in one shared sequence, so a bare number is unambiguous and you never need to know whether an `impl-<n>` came from impl or revise mode. A candidate is **done** when its number is absent from that union. As a second guard, never remove a path a running agent reports as its worktree (`TaskList`) even if it looks done. **If either query errors, skip hygiene entirely this tick** and say so — never remove against a stale or partial active set.
- **D. Remove, capped.** For each done candidate: `git worktree remove --force "<exact path from git worktree list>"` — one Bash call per path, **at most 5 per tick**, oldest first. 25 removals in one tick is 25 calls; the remainder is picked up next tick. **Only ever pass a path that `git worktree list` shows.**

**Worked example:**

```
/repo                                        → main checkout, never a candidate
/repo/.claude/worktrees/impl-51              → 51, from the path
/repo/.claude/worktrees/agent-aa714ce408044821d
  HEAD 06e73c76…  →  "#60 fix install-to-adopt verification and reload step"  →  60
active set = {62}  →  51 and 60 are done  →  remove both
```

**Report every tick, in one of these exact forms.** An adjective like "pruned" is never a sufficient report, and zero removals must say `none`, never be implied:

- Removals made:

  > **Worktrees:** removed 5 — `.claude/worktrees/impl-1`, `impl-2`, `impl-3`, `impl-4`, `impl-5`. 20 finished remain; continuing next tick.

- Nothing to do:

  > **Worktrees:** none removed — 1 registered, all active.

- Uncorrelatable candidates present, appended to either line above:

  > 2 uncorrelatable (`agent-1a2b…`, `agent-3c4d…`) — run `/port:worktree-clean`.

- Active-set query failed:

  > **Worktrees:** skipped this tick — the active-set query failed; nothing removed.

On Windows, `git worktree remove` often fails once a dependency directory exists, and orphans accumulate that neither `remove` nor `prune` can clear. **Do not claim "prune will fix it next tick" — it will not.** Report the failure and tell the human to run `/port:worktree-clean`.

**Denial report (each tick).** The guard hook logs every `deny` and `miss` decision it makes to **`.agents/denials.log`**, one four-field tab-separated line each (format in `PIPELINE.md` → "Denial visibility"). Read it and count only lines whose decision field is `deny` — those are the guard hook actually denying a dispatched subagent. A `miss` line is **not a denial**: it is this session's own (or another non-subagent session's) allowlist miss, already surfaced to a human as a normal prompt, and never worth reporting here. Track how many qualifying `deny` lines are new since the previous tick. If they **cluster** — three or more new, or the same command repeated — report it once, e.g. *"⚠️ 4 stage-agent commands denied this tick (e.g. `printf … >` ×2) — the pipeline likely needs a permission or instruction change."* Do not act on it automatically; this is visibility so the human knows when to harden the configuration. A few isolated denials are normal and need no report.

**Unowned report (each tick).** Report **only when the set changes**, in one line, and **never act on it**:

> ⚠️ Unowned pipeline items (no assignee — no cockpit will act on them): #412 (ready), #388 (plan review). Say "work on #412" to claim one.

An **empty** sweep result is only meaningful if the `--jq` filter works — verify it once against a known unassigned, trigger-labeled issue rather than trusting silence.

**Ungated report (each tick).** *(`modules.approvalGate`)* A pipeline pull request that lost `<labels.marker>` merges with no gate at all, and CI cannot tell it from a human pull request. Report changes only, and **never add the label automatically**:

> ⚠️ Pipeline pull requests without the `<labels.marker>` label (approval gate inactive): #501. Say "gate #501" or add the label on GitHub.

**Preview refresh (right after confirming merges).** *(`modules.previewDatabase`)* Each merge frees exactly one preview database slot, which unblocks one quota-red deployment. Count the merges you confirmed **this tick** as `k`, then label **at most `k`** pull requests `<labels.refreshBranch>` — **oldest first**, each open, approved, with the deployment check red while the other checks are green, and skipping any whose `headRefOid` this session already refreshed at that same SHA. Read the rollup per candidate:

```bash
gh pr view <n> --repo <repo> --json headRefOid,statusCheckRollup --jq '{sha: .headRefOid, checks: [.statusCheckRollup[] | {n: (.name // .context), s: (.conclusion // .state)}]}'
```

Deployment providers often surface as a StatusContext rather than a CheckRun, hence the `//` fallbacks. Refreshing more than `k` would just re-exhaust the quota; a missed refresh is harmless because the next merge retries it.

## Dispatching

One background subagent per actionable item:

```
Agent({
  description: "<stage> #<n>",
  subagent_type: "<plan-agent|impl-agent|review-agent|revise-agent>",
  model: "<the matching entry from models>",
  run_in_background: true,
  prompt: "Run your pipeline stage for #<n>. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly."
})
```

**`model` is the one field you set beyond the stage.** Agent frontmatter is static, so an agent file cannot read `models` from config; passing it here is what honours the configuration, and it takes precedence over the frontmatter default. Everything else — tool scope, permission mode, `maxTurns`, worktree isolation — comes from the agent definition.

Stage mapping:

| Trigger | `subagent_type` | Model |
| --- | --- | --- |
| Issue at `<labels.ready>` | `plan-agent` (fresh plan) | `models.plan` |
| Issue at `<labels.planChangesRequested>` | `plan-agent` (revision) | `models.plan` |
| Issue at `<labels.planApproved>` | `impl-agent` — **unless `SESSION REQUIRED`: announce, never dispatch** | `models.impl` |
| Pull request at `<labels.readyForReview>` | `review-agent` | `models.review` |
| Pull request at `<labels.needsRevision>` | `revise-agent` — **after the cycle-cap check**; **unless `SESSION REQUIRED`: announce, never dispatch** | `models.revise` |
| Pull request at `<labels.refreshBranch>` *(`previewDatabase`)* | `revise-agent` in **refresh mode** | `models.revise` |

**Session-required items never dispatch.** Before dispatching impl or revise, check that item's `body` for the literal string `SESSION REQUIRED`. It is already in the trigger query's result — both request `body` — so this costs no extra call. Present → announce, do not dispatch. Absent → dispatch normally.

For a refresh, say so in the prompt so the agent takes its refresh path: `Run your pipeline stage for PR #<n> in refresh mode.`

### Cycle cap (before every revise dispatch)

```bash
gh pr view <pr-number> --repo <repo> --json reviews --jq '[.reviews[] | select(.body|startswith("## Code Review"))] | length'
```

If that count is **at or above `reviewCycleCap`** and the latest review still produced Critical or Medium findings, escalate instead of dispatching: write the note to `.temp/escalation-<pr>.md` with the Write tool, then

```bash
gh pr edit <pr-number> --repo <repo> --remove-label "<labels.needsRevision>" --add-label "<labels.needsHuman>"
gh pr comment <pr-number> --repo <repo> --body-file .temp/escalation-<pr>.md
```

then notify the human.

## Human gates

### Plan review

For each issue at `<labels.planReview>`:

- **Without `<labels.autoPlan>`:** summarize the plan from the issue body in a few sentences, then ask (AskUserQuestion): **Approve** / **Request changes** / **Discuss**. If the plan carries the `SESSION REQUIRED` marker, say so in the summary — the human should learn at the gate that they will be running this one themselves.
  - Approve → `gh issue edit <n> --repo <repo> --remove-label "<labels.planReview>" --add-label "<labels.planApproved>"`. Implementation dispatches this tick, unless the plan is session-required, in which case this tick announces instead.
  - Request changes → write the feedback to `.temp/feedback-<n>.md`, `gh issue comment <n> --repo <repo> --body-file .temp/feedback-<n>.md`, then swap to `<labels.planChangesRequested>`.
  - Discuss → converse, then finish with one of the two transitions above.
- **With `<labels.autoPlan>`:** swap to `<labels.planApproved>` immediately, no interaction, and dispatch this tick — same session-required exception.

The gate applies **no special label** for a session-required plan; the marker is already in the body.

### Session-required items

**Surfacing these is your job, and nothing else will do it.** An item whose body carries the marker keeps its trigger label and is **never** dispatched. No agent will pick it up, so if you do not tell the human it sits there indefinitely — silently, because a trigger label normally means something is already moving. Announce it **once per session per item**, then take no other action.

**Say "separate session", and mean it.** This cockpit has no `Edit` in its tool scope and runs on haiku, so it cannot do the work; and it must stay free to keep ticking, since a long implementation here would stall every other item. Hand over the launch command with the name pre-filled, derived from the **issue** title.

- **Issue at `<labels.planApproved>` with the marker:**

  > 🧰 #503 is marked **`SESSION REQUIRED`** — it touches paths a dispatched agent can't edit, so I won't be implementing this one. **Open a separate session and run it there** (not here — I need to keep ticking):
  > `claude -n "#503: operator config route"` then `/port:implement 503`
  > Nothing moves until you do. I'll pick it back up automatically at review.

- **Pull request at `<labels.needsRevision>` with the marker** — announce **after** the cycle-cap check, which still runs and can still escalate:

  > 🧰 PR #512 needs revision and is marked **`SESSION REQUIRED`** — I can't dispatch for it. **In a separate session** (not here): `claude -n "#503: operator config route"` then `/port:implement 512`. Nothing moves until you do; I'll review again once it's back at ready-for-review. (The session name carries the **issue** number; the command takes the pull request number.)

### Approved pull requests

Announce each newly approved pull request once with a one-line summary and its URL; the human merges on GitHub. Track which you have announced in-session; re-announce only on request. When one is merged, the next tick's reconciliation drops it and announces the merge — **never keep listing a merged pull request as awaiting merge.**

*(`modules.previewDatabase`)* If its rollup shows the deployment check red, append `⚠️ deployment red — not merge-ready; a slot frees on the next merge`, so the human is never told to merge something GitHub will refuse.

### Agent questions and blockers (relay loop)

When a background subagent completes, read its final message:

- `QUESTIONS FOR HUMAN:` → present the questions, collect answers, and **resume that same agent** by sending the answers back via SendMessage, using the agent ID from the completion notice. Do not dispatch a fresh agent while one is resumable.
- `BLOCKED:` → present the blocker and the decision needed; relay the human's decision back to the same agent via SendMessage.
- **A session-limit message** (e.g. *"You've hit your session limit · resets 4:10pm (America/New_York)"*), especially when it shows up for every in-flight agent in the same tick → this is the usage-limit class (see "Liveness cross-check"). Do not redispatch, do not change models. Reset each affected item's in-flight label to its trigger label — one `gh` call per item, never a loop — and report:

  > ⛔ Usage limit — all 4 dispatched agents failed with *"You've hit your session limit · resets 4:10pm (America/New_York)"*. Parked #63, #67, #71 and PR #117 back at their trigger labels; nothing redispatches before the reset, and I have not changed any model. **Next tick:** ~2400s (just after 4:10pm).

  Call `ScheduleWakeup` for just after the reported reset time — a small buffer past it, or the idle delay with a note if the time cannot be parsed.
- Anything else → a completed stage; the labels it set drive the next tick.

## Conversational commands

Interpret intent, not literal syntax.

- **"work on #N"** — opt-in. **Opt-in claims ownership**; labelling without assigning would leave the ticket invisible to the very cockpit that just opted it in. First read the blockers and the current owner:

  ```bash
  gh api graphql -f query='query { repository(owner: "<owner>", name: "<name>") { issue(number: <n>) { blockedBy(first: 10) { nodes { number title state } } } } }'
  gh issue view <n> --repo <repo> --json assignees --jq '.assignees[].login'
  ```

  Warn if any blockers are unmerged. Then:
  - **Unassigned, or already only you** → proceed. Ask (AskUserQuestion): plan gate **Interactive** (review the plan — **the default for features**, so the human shapes the design before any code) or **Auto-approve** (only for small or bug-fix tickets), then add `<labels.marker>` and `<labels.ready>`, plus `<labels.autoPlan>` for auto-approve, together with `--add-assignee "@me"`.
  - **Assigned to someone else** → ask **before touching it**: **Take over** (remove them, add yourself, then proceed) or **Cancel** (change nothing — no labels, no assignee). Never a plain `--add-assignee` on top of another operator: two assignees means two cockpits both dispatch.

  Dispatch the plan agent the same tick.

- **"scope out X" / "break down X"** *(`modules.scope`)* — stage 0 deserves a stronger model than haiku; suggest the human run `/port:scope` in their main session. When the module is off, say the pipeline has no decomposition flow configured and offer to work on an existing ticket instead.
- **"status"** — re-run the tick queries **live** and build the table from them, never from session memory: each in-flight item and its stage, each item waiting on the human, and each pull request currently approved (from the live query — a merged one has already dropped out, so it must not appear). Run the liveness cross-check too, and list any **stalled** item alongside the in-flight ones rather than as a separate step. It **inherits the assignee filter**, so append the unowned sweep as its own line, and the ungated sweep too when that module is on, so a stalled ticket or an ungated pull request is diagnosable from one command. List **session-required** items under the human-gated group with the commands to run.
- **"pause #N"** — remove the item's current trigger label; confirm what was removed. If it belongs to **another operator**, say so and stop rather than touch its labels.
- **"resume #N" / "retry #N"** — re-apply the trigger label for where it stalled (stuck at `<labels.planning>` → `<labels.ready>`; stuck at `<labels.revising>` → `<labels.needsRevision>`; and so on). If the item is **unassigned**, add `--add-assignee "@me"` in the same command, since re-applying a trigger to an unassigned item is a no-op for every cockpit. If it belongs to another operator, say so and stop.
- **"refresh #N"** *(`modules.previewDatabase`)* — apply `<labels.refreshBranch>` and dispatch this tick, bypassing the per-merge cap. Use it to force a fresh deployment on a pull request left quota-red.
- **"gate #N"** *(`modules.approvalGate`)* — apply the missing `<labels.marker>` to a pull request the ungated sweep reported. The `labeled` event re-evaluates the workflow's condition, so the gate is live on that run.

## Stop controls

A session-level **draining** flag gates dispatch:

- **"drain" / "pause the pipeline"** — set draining on. Stop dispatching and **stop scheduling wakeups**; let in-flight agents finish and keep relaying their completions. Report what is still running (`TaskList`).
- **"resume" / "unpause"** — set draining off and run one tick immediately.
- **"stop #N" / "cancel #N"** — remove its trigger label; if an agent is in flight for it, find it with `TaskList` and `TaskStop` it; then reset its in-flight label back to the trigger so it can be retried. Same ownership rule as opt-in.
- **"stop everything" / "halt"** — set draining on, `TaskStop` every running stage agent, and reset each one's in-flight label to its trigger. Report what was halted. No ownership check is needed here: this only touches agents *this* cockpit dispatched, which are by construction all yours.

While draining, a tick still reports gates and relays completions, but dispatches nothing and schedules no wakeup. Closing this session also halts all dispatch, since it is the only dispatcher, but cuts off in-flight agents — prefer `drain`.

## Pacing

**Step 7 of every non-draining tick** (see Tick procedure) is calling `ScheduleWakeup` with prompt `/port:pipeline`, before the tick report is written:

- Any agent in flight, or any item mid-pipeline → ~270 seconds.
- Fully idle → ~1500 seconds.

**The idle path is where this call gets skipped, and it is the path that matters most.** With nothing in flight there are no agent completions to wake the session, so the scheduled wakeup is the *only* thing that catches a human applying a label on GitHub. An idle tick that ends in prose instead of the `ScheduleWakeup` call never ticks again — silently, and after telling the human it would.

**Self-check, every non-draining tick:** before ending the turn, confirm `ScheduleWakeup` was actually called this tick. If it was not, call it now — do not write the closing line first and let the sentence stand in for the call. **Carve-out:** this self-check applies to ticks, not to a refused or stopped start — a startup that fails the preflight schedules no wakeup, and that is correct, not a violation of this rule.

Close every non-draining tick's report with the delay you actually scheduled: `**Next tick:** ~1500s (scheduled)` or `**Next tick:** ~270s (scheduled)`. While draining, step 7 is skipped entirely (see Stop controls) and the closing line reads `**Next tick:** none — draining. Say "resume" to restart ticking.`

Background-agent completions wake this session automatically in between ticks; the scheduled wakeup is only the fallback that catches everything else. On every wakeup, run the tick procedure again.

## Manual and recovery

Each stage is also runnable by hand without this cockpit — mention the subagent directly, or run a whole session as it. All durable state is in labels, so `retry #N`, or re-applying the trigger label on GitHub, recovers any stalled item. **Exception:** an item marked `SESSION REQUIRED` is never dispatched — run `/port:implement <n>` in your own named session.
