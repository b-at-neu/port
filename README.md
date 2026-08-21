# port

A Claude Code plugin that turns GitHub issues into merge-ready pull requests, with humans at the gates that matter.

GitHub labels are the state machine. A cockpit session polls them, dispatches four stage agents — plan, implement, review, revise — into isolated git worktrees, and runs the human gates conversationally. Because state lives on GitHub rather than in a session, progress is always visible, and you can intervene by changing a label at any time.

This repository is both the plugin and its own marketplace.

## Install

Once per machine. **This is not per-repository** — see [Adopt a repository](#adopt-a-repository) for that.

```bash
claude plugin marketplace add b-at-neu/port
claude plugin install port@port
```

Check it loaded:

```bash
claude plugin details port
```

You should see 7 skills, 4 agents, and 1 hook. A component that fails to parse is **silently absent** from that inventory rather than reported as an error, so check the counts rather than looking for a complaint.

### Which scope

The commands above install at **user scope**, which is the right default: `/port:init` has to be available in a repository *before* that repository is set up, and project scope creates a chicken-and-egg — you would have to install into the repo, reload, and only then adopt it.

For a team, add `--scope project` in each managed repository as well. That commits `enabledPlugins` and `extraKnownMarketplaces` to its `.claude/settings.json`, so a teammate gets the pipeline on clone instead of setting it up themselves. Costs an extra step and a reload; worth it once more than one person operates the same repository.

## Adopt a repository

Once per repository you want the pipeline to manage. From inside it:

```
/port:init
```

It detects the toolchain, asks which subsystems you want, then writes `.claude/port.config.json`, merges the permission lists into `.claude/settings.json`, creates the label vocabulary, and optionally installs a CI merge gate. Nothing is written without showing you first, and re-running reconciles rather than duplicating.

It finishes by offering `/port:analyze`, which reads the codebase and proposes engineering standards. Worth accepting: `docs.engineering` is what gives the stage agents a quality bar to build to and review something to cite.

### Before you start

Four things, each of which otherwise fails confusingly:

- **`gh` authenticated**, with access to the repository. Every stage agent works through it.
- **An integration branch distinct from your default branch.** Feature pull requests target `branches.integration` (`dev` by default) and never the production branch. *This repository has only `main`* — so adopting the pipeline here means creating one first.
- **Run the cockpit in `default` permission mode.** Not `acceptEdits`, `bypassPermissions`, or `auto`. A parent session in any of those overrides the stage agents' `dontAsk`, and their denied commands start prompting *you* instead of being auto-denied. This is the most likely cause of "why is it asking me things".
- **A branch ruleset**, if you want the approval gate enforced rather than advisory. `/port:init` will tell you it has not created one; making a check required is an administrative change it deliberately leaves to you.

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

```
.claude-plugin/marketplace.json   # this repo as a marketplace
plugins/port/
  agents/                         # plan, impl, review, revise
  skills/                         # the seven above
  hooks/                          # denial logging
  templates/                      # written into managed repos by /port:init
  docs/PIPELINE.md                # the operator's reference
schema/port.config.schema.json    # the per-repo config contract
```

Each managed repository commits a `.claude/port.config.json` describing its branches, toolchain commands, and which optional subsystems it wants. Plugins cannot ship permission rules, which is why `/port:init` exists to install them into the repository itself.

Developing the plugin: [CONTRIBUTING.md](CONTRIBUTING.md).
