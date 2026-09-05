# port

A Claude Code plugin that turns GitHub issues into merge-ready pull requests, with humans at the gates that matter.

GitHub labels are the state machine. A cockpit session polls them, dispatches four stage agents — plan, implement, review, revise — into isolated git worktrees, and runs the human gates conversationally. Because state lives on GitHub rather than in a session, progress is always visible, and you can intervene by changing a label at any time.

This repository is both the plugin and its own marketplace.

## Install and adopt

Everything here is **per-repository**. Nothing is installed globally.

From inside the repository you want the pipeline to manage:

**Step 1 — install.**

```bash
claude plugin marketplace add b-at-neu/port@main --scope project
claude plugin install port@port --scope project
```

The `@main` pin is the release branch, so this installs a released version regardless of which branch happens to be default. Step 3's `/port:init` then narrows the install to the exact published release, pinning it in place.

Both write to that repository's `.claude/settings.json`, which is committed. So the pipeline **travels with the repository**: anyone who clones it gets the same plugin from the same source, with no separate setup, and nothing leaks into your other projects.

**Step 2 — load it into a session.** Installing does not load the plugin into the session you installed from — that session resolved its plugins at startup, before the install existed. **Start a new session** in the same directory. Skipping this makes the next step fail with `Unknown skill: port:init`, an error that says nothing about reloading.

**Step 3 — run `/port:init`.** This is the verification and the adoption in one: it either resolves or it does not, and that is the only question worth asking at this point.

```
/port:init
```

It detects the toolchain, asks which subsystems you want, then writes `.claude/port.config.json`, merges the permission lists into `.claude/settings.json`, creates the label vocabulary, and optionally installs a CI merge gate. Nothing is written without showing you first, and re-running reconciles rather than duplicating. See [Before you start](#before-you-start) for the five prerequisites.

It also reconciles the `port` marketplace entry that step 1's install command wrote — pinning `ref` to the **last published release** (a `v<semver>` tag, or `main` if none has shipped yet) and turning `autoUpdate` on, so a later release actually reaches your install instead of sitting unfetched. It tells you when that pin changes what you are running, naming both the previous and the new ref. Plugin updates land on the **next** session, never mid-session, and `DISABLE_AUTOUPDATER` suppresses them entirely unless `FORCE_AUTOUPDATE_PLUGINS=1` is also set.

**Step 4 — accept the `/port:analyze` offer.** `/port:init` finishes by offering it — it reads the codebase and proposes engineering standards. Worth accepting: `docs.engineering` is what gives the stage agents a quality bar to build to and review something to cite.

### Before you start

Five things, each of which otherwise fails confusingly:

- **`gh` authenticated**, with access to the repository. Every stage agent works through it.
- **Either two long-lived branches, or one.** Feature pull requests always target `branches.integration` (`dev` by default) and never the production branch. With two branches, `branches.production` names the release target. With one — your default branch doubles as `integration` — `/port:init` proposes single-branch mode: `branches.production` is null, `modules.release` is off, and there is no release flow. `/port:init` detects which you have and never creates a branch on your behalf.
- **The committed `.claude/port.config.json` must land on your repository's default branch.** Dispatched agents resolve their config from `origin/HEAD` before they have read any config at all, so a config change that only reaches your integration branch does not reach them — it has to reach the default branch too, whether that is directly or through your normal release flow. Skip this and dispatch halts, reporting the repository as unmanaged.
- **Run the cockpit in `default` permission mode.** Not `acceptEdits`, `bypassPermissions`, or `auto`. A stage agent's denied commands are handled by a `PreToolUse` guard hook, independent of your session's mode — but `default` keeps *your own* edits from auto-accepting, so any residual dialog stays visible instead of silently approved. This is the most likely cause of "why is it asking me things".
- **A branch ruleset**, if you want the approval gate enforced rather than advisory. `/port:init` will tell you it has not created one; making a check required is an administrative change it deliberately leaves to you.

### Why project scope

A repository that declares its own tooling is self-describing: the pipeline, its version, and the plugins chosen for its stack are all recorded in the repository rather than in one person's machine state. Clone it and you have the same setup.

The alternative — installing once at user scope — is fewer keystrokes and makes `/port:init` available everywhere, but it means the pipeline exists only on the machine that installed it, and every plugin picked for one repository's stack loads in all your others. `/port:analyze` scopes its plugin recommendations to the repository for the same reason.

### Checking the component inventory

```bash
claude plugin details port
```

You should see 7 skills, 4 agents, and 1 hook. A component that fails to parse is **silently absent** from that inventory rather than reported as an error, so check the counts rather than looking for a complaint.

This reports what is **installed**, not what your session has **loaded** — it can list all seven skills in a session where `/port:init` does not resolve, which is why it is not the verification step.

## Day to day

```
/port:pipeline
```

Then talk to it. `work on #142` opts a ticket in and starts planning. `status` reports live state. `drain` finishes what is in flight and starts nothing new.

The plan gate comes back to you in the terminal: approve it, or give feedback and it revises. After that, implementation, review, and revision run on their own until the pull request is `approved` — then you merge on GitHub. The pipeline never merges.

Full walkthrough: [docs/USAGE.md](docs/USAGE.md). Reference for the label lifecycle, permission model, and output formats: [plugins/port/docs/PIPELINE.md](plugins/port/docs/PIPELINE.md).

## Skills

| Skill | What it does |
| --- | --- |
| `/port:init` | Adopt a repository |
| `/port:analyze` | Read the codebase, propose engineering standards, recommend plugins |
| `/port:pipeline` | The cockpit — poll, dispatch, run the gates |
| `/port:scope` | Break a feature into an epic with dependency-ordered sub-issues |
| `/port:implement` | Run a stage yourself, for tickets an agent cannot be given |
| `/port:release` | Cut a release, integration to production |
| `/port:worktree-clean` | Reclaim stale agent worktrees |

## Layout

Each managed repository commits a `.claude/port.config.json` describing its branches, toolchain commands, and which optional subsystems it wants. Plugins cannot ship permission rules, which is why `/port:init` exists to install them into the repository itself.

Full repository map, the ship boundary, and why several placements cannot move: [ARCHITECTURE.md](ARCHITECTURE.md).

Developing the plugin: [CONTRIBUTING.md](CONTRIBUTING.md).
