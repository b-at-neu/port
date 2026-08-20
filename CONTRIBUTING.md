# Contributing

## Working on the plugin

This repository is both a plugin marketplace and the plugin it distributes. Install it from a local path and edit in place:

```bash
claude plugin marketplace add /absolute/path/to/port
claude plugin install port@port
```

Edits under `plugins/port/` take effect immediately — there is no build step and nothing to invalidate. A session that is already running has loaded its components, so run `/reload-plugins` there to pick up changes.

## Checking that a change loaded

```bash
claude plugin details port
```

This prints the component inventory. **A skill that fails to parse is silently absent from it rather than reported as an error** — so check that the counts went up, rather than looking for a complaint.

After editing `marketplace.json` or `plugin.json`, re-validate them:

```bash
claude plugin marketplace update port
```

## Writing hooks

Once installed at user scope the plugin loads in every session, whatever the working directory. A hook must therefore return immediately when the repository has no `port.config.json` — without that guard, installing this plugin changes behaviour in every unrelated project on the machine.

## Commit messages

Subject: `#<issue> <imperative lowercase summary>`, under 80 characters, no trailing period. Use `#0` when a commit genuinely has no issue.

Write the message to a file and `git commit -F <file>` rather than using inline `-m`, which collapses on Windows and drops the subject and co-authorship.

## Engineering standards

This repository has no standards document of its own yet. Until it does: small focused files, no dead scaffolding or transitional shims, comments only where a fluent reader would still get it wrong, and no placeholder content committed in anticipation of a later ticket.
