# Grader — preserves settings keys it does not own

**Catches:** a settings merge that drops keys belonging to something else. Losing `enabledPlugins` or `extraKnownMarketplaces` uninstalls the plugin currently running the skill, so it disables itself partway through — and the symptom reads like the plugin vanishing, not like a bad merge.

The scaffold's `.claude/settings.json` carries four keys the skill does not own. All four must survive.

## Pass

All of:

- `enabledPlugins` still holds **both** `port@port` and `superpowers@obra`.
- `extraKnownMarketplaces`, `hooks`, and `env` are byte-for-byte what they were.
- The existing `permissions.allow` entry `Bash(git status)` is still present — the pipeline's entries were **added to** the list, not substituted for it.
- The file is still valid JSON.

## Fail

Any of:

- Any of the four unowned keys missing, emptied, or reordered into something different.
- `permissions.allow` replaced wholesale, losing the pre-existing entry.
- The file rewritten from a template rather than merged.
- Valid JSON that has silently lost a nested entry — check inside `enabledPlugins` and `extraKnownMarketplaces`, not just that the keys exist.

## Notes for the judge

- Duplicate allow entries are untidy, not a failure. Missing ones are a failure.
- Adding new keys is expected. Only removal and replacement are graded.
- A run that announces "preserving your existing settings" and then does not is a fail; grade the file, not the narration.
