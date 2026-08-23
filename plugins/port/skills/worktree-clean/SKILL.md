---
name: worktree-clean
description: Reclaim disk space from stale pipeline worktrees — prune git registrations and force-delete orphaned agent worktree directories left under .claude/worktrees/, the dependency-laden leftovers git's own remove and prune cannot clear on Windows. Run manually from the main checkout when worktrees accumulate.
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Clean up pipeline worktrees

Pipeline agents run in isolated worktrees under `.claude/worktrees/`; operator-run session-required tickets add their own there too. Both are in scope.

On Windows, once an agent has installed dependencies, the harness often **de-registers** the worktree — removing its `.git` file — but **cannot delete the directory**: a populated dependency tree, and long or bracketed paths, defeat both `git worktree remove` (which fails with `Invalid argument`) and `git worktree prune` (which only clears registrations whose directory is *already* gone). These **orphan directories** then accumulate, hundreds of megabytes each.

The cockpit deliberately does **not** force-delete them in its autonomous loop. This skill does, interactively, run by you from the **main checkout**.

> **Scope guard:** this skill only ever deletes directories **directly under `.claude/worktrees/`**. Never delete anything outside that directory, never the main checkout, and never a worktree belonging to an **in-flight** pipeline item — check `gh pr list` or the cockpit first if unsure.

## Steps

1. **Prune dangling registrations.** Safe: this only affects worktrees whose directory is already gone.

   ```bash
   git worktree prune
   ```

2. **Compare what git tracks against what is on disk:**

   ```bash
   git worktree list
   ls -1 .claude/worktrees/
   ```

3. **Identify the deletable set:**
   - **Orphans** — directories under `.claude/worktrees/` that do **not** appear in `git worktree list`. No `.git` file, so git does not track them; always safe to delete.
   - **Registered but done** — a worktree that *is* listed, but whose item carries no open pipeline label. Correlate it the same way the cockpit's per-tick hygiene does (`skills/pipeline/SKILL.md` → "Worktree hygiene"): `.claude/worktrees/impl-<n>` carries its number straight off the path; `.claude/worktrees/agent-<hash>` carries none, so resolve it through its `HEAD` commit's `#N` subject (`gh api graphql`) first, then check that number against `gh issue list`/`gh pr list` for an open pipeline label. Then try `git worktree remove --force "<exact listed path>"` first; if it fails, fall through to the force-delete below and re-run `git worktree prune`.

   Show the human the list, with sizes where useful (`du -sh .claude/worktrees/* 2>/dev/null`), and **confirm before deleting**.

4. **Force-delete each orphan directory.** Run one per directory so each is visible and separately approved.

   ```bash
   rm -rf ".claude/worktrees/<dir>"
   ```

   On Windows, where a locked dependency tree or a long path defeats `rm -rf`:

   ```bash
   powershell -NoProfile -Command "Remove-Item -LiteralPath '.claude/worktrees/<dir>' -Recurse -Force"
   # fallback if PowerShell balks on the path:
   cmd //c rmdir /s /q ".claude\\worktrees\\<dir>"
   ```

5. **Final prune**, to clear any registrations the deletions exposed:

   ```bash
   git worktree prune
   git worktree list
   ```

Afterwards, `.claude/worktrees/` on disk should match `git worktree list` — nothing but the main checkout and genuinely in-flight worktrees.
