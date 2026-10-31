---
name: plugin-cache-clean
description: Remove plugin cache versions pinned by deleted or moved projects — a local/project-scope install record keyed by a projectPath that no longer exists, which Claude Code's own 14-day sweep never catches because no orphan marker is ever written for it. Machine-wide, not per-repository; run whenever cache/port/port/<version>/ directories accumulate.
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Clean up the plugin cache

`installed_plugins.json` is per-machine, not per-repository: one run here covers every project this machine has ever installed port into, not just the repository this session happens to be in. The script needs no `.claude/port.config.json` and is never copied into a repository by `/port:init` — the problem this fixes is per-machine, so a per-repo copy would be the wrong shape.

**Why the 14-day sweep misses these.** It fires on an `.orphaned_at` marker written when Claude Code recognizes a version bump as an update to the same tracked install. A `local`/`project`-scope record is keyed by its `projectPath`; deleting that directory (a worktree, a removed clone, a moved repository) never removes the record, and `claude plugin uninstall --scope local` cannot run from a directory that no longer exists. The record goes on pinning its version directory, and no marker is ever written for it.

## Steps

1. Run the report, read-only:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/plugin-cache.mjs" report --json
   ```

   Show both tables — stale install records (key, scope, project path, resolved install path) and unreferenced cache directories. If both are empty, say so and stop; there is nothing to clean.

2. Explain the two kinds of entry the report can show:
   - A **stale record** whose project is genuinely gone — safe to remove.
   - A **live record** still pinning a version because its project exists but was never uninstalled in place. To free that version instead, run `claude plugin uninstall port@<marketplace> --scope local` from inside that project, then re-run this skill.

3. Confirm with the operator, then apply:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/plugin-cache.mjs" apply
   ```

   Show the backup path it prints (`installed_plugins.json.bak-<timestamp>`, beside the original) and the counts removed.

4. Re-run `report` to confirm the stale entries are gone, and remind the operator to restart any running Claude Code session so it stops resolving what was just removed.

## Another machine or config directory

This skill is machine-wide and reads no repository config — run it directly on the other machine. For a config directory other than the current user's (another account, a mounted or synced home, a backup), pass `--home "<dir>"` to both `report` and `apply`. There is no remote/SSH mode: a network write into someone else's `~/.claude` is a larger trust surface than this earns, so the fix for a remote machine is running the skill there.

## Widening scope

By default the script only ever touches `port@port` records and cache directories. A repository whose own local development loop installs this plugin under a second, differently-named marketplace can widen scope to cover it too: `--plugins port@port,<marketplace>@port` on both `report` and `apply`, comma-separated. Deletion stays fenced to exactly the marketplaces named — never a vendor outside the list.
