---
name: worktree-clean
description: Interactive front end to the worktree reclamation script — reviews the classified table, then unlocks, force-clears dirty candidates, and force-deletes orphaned agent worktree directories the cockpit's own automatic reclaim (and git's own remove/prune) leave behind. Run manually from the main checkout when worktrees accumulate.
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Clean up pipeline worktrees

Pipeline agents run in isolated worktrees under `.claude/worktrees/`; operator-run session-required tickets add their own there too. Both are in scope.

`bin/worktrees.mjs` (addressed via `commands.worktrees`) is the one classifier and reclaimer this skill, the cockpit's own per-tick hygiene, and #109's worktree report all share — see `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` → "Worktree lifecycle". This skill drives it **interactively**, for the four cases the cockpit's automatic pass deliberately never touches on its own: a **locked** worktree, a **dirty** one, an **unresolved** one, and an **orphan directory** git does not track at all.

> **Scope guard:** the script enforces its own fence now — `reclaim` only ever removes a path `git worktree list` itself reports, and `purge --orphan` only ever deletes a path this run's own scan just classified `orphan-dir`, refusing anything else (exit `2`, nothing touched). This skill drives `purge` interactively; it no longer holds any deletion logic of its own.

**If `commands.worktrees` is null** — the repository has not installed the script (`/port:init` skips it when Node is unavailable, or it predates #144). Say so plainly and stop; there is nothing to drive.

## Steps

1. **Report first, remove nothing.**

   ```bash
   <commands.worktrees> report --json
   ```

   If the JSON carries any `advisories`, show each one first — a Windows repository with `core.longpaths` still off is the one that explains most of what follows. Then show the human the classified table — path, state, reason. **Confirm before doing anything destructive.**

2. **Reclaim what is plainly safe**, no confirmation needed beyond step 1's overview — this mirrors exactly what a tick would do on its own:

   ```bash
   <commands.worktrees> reclaim --max 20
   ```

3. **Locked candidates.** For each the report marks `locked` with an "otherwise reclaimable" reason, confirm with the human, then:

   ```bash
   <commands.worktrees> reclaim --issue <n> --unlock
   ```

   Never unlock a candidate the report does **not** say is otherwise reclaimable — a lock on a genuinely active worktree is a deliberate statement, by a human or the harness, and stays.

4. **Dirty candidates.** For each the report marks `dirty`, show the uncommitted file count, confirm the human wants to discard it, then:

   ```bash
   <commands.worktrees> reclaim --issue <n> --force-dirty
   ```

   This is destructive — uncommitted work is lost — so never run it without an explicit confirmation naming the candidate.

5. **Unresolved candidates.** The report names the reason (no upstream branch, no `#N` subject, HEAD not on the integration branch). Resolve by hand — check `gh issue list` / `gh pr list` for the likely number, or ask the human — then either `reclaim --issue <n>` once you know it is done, or leave it: the script never guesses.

6. **Orphan directories — purge, interactively, one at a time.** The report lists any directory beside a registered worktree that git does not track at all (`orphan-dir`); `report`/`reclaim` never delete these themselves. Show the human the list, confirm, then delete through the script, one path per confirmation:

   ```bash
   <commands.worktrees> purge --orphan "<exact orphan-dir path from the report>"
   ```

   `purge` re-derives the orphan set itself and refuses (exit `2`, nothing deleted) any path that is not a member — the scope guard above is enforced by the script now, not by this skill's own care. It uses the same `fs` fallback `reclaim` does, so a populated, long-path, or read-only dependency tree that used to defeat a plain forced delete on Windows is handled the same way here, on every OS.

7. **Final report**, to confirm the state after every action above:

   ```bash
   <commands.worktrees> report
   ```

Afterwards, only genuinely in-flight worktrees (`active`) and anything still `unresolved` should remain.
