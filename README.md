# port

A Claude Code plugin that packages a GitHub-driven agent pipeline — plan, implement, review, revise — so it can be installed into any repository instead of living inside one.

The pipeline uses GitHub labels as a durable state machine. A `/pipeline` cockpit session polls those labels, dispatches background stage agents into isolated git worktrees, and runs the human gates conversationally. Because state lives on GitHub rather than in a session, progress stays visible and manual intervention always works.

This repository is both the plugin and its own marketplace.

## Status

Early scaffolding. Nothing is installable yet — see the [open issues](https://github.com/b-at-neu/port/issues) for the milestone 1 breakdown.

## Planned layout

```
.claude-plugin/marketplace.json   # this repo as a marketplace
plugins/port/                     # the plugin itself
  agents/                         # plan, impl, review, revise
  skills/                         # port-init, pipeline, scope, implement, release, worktree-clean
  hooks/                          # denial logging
  templates/                      # written into managed repos by /port-init
  docs/PIPELINE.md                # the operator manual
schema/port.config.schema.json    # the per-repo config contract
```

Each managed repository commits a `.claude/port.config.json` describing its branches, toolchain commands, and which optional subsystems it wants. Plugins cannot ship permission rules, so a `/port-init` skill installs those into the target repo's `.claude/settings.json` along with the label vocabulary and an optional CI merge gate.
