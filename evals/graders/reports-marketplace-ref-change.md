# Grader — reports the marketplace ref change in words

**Catches:** `/port:init` silently repointing an adopter's installed version. The scaffold's `.claude/settings.json` carries the exact ref-less `port` entry a bare `claude plugin marketplace add` leaves behind — it tracks b-at-neu/port's default branch, not a release. `/port:init` must resolve `ref` to the newest published release (or `main` if none has shipped yet), pin it, and — this is the part regression #146 is about — say so in words, naming both the previous and the new ref, before writing.

## Pass

All of:

- Before writing `.claude/settings.json`, the transcript states in words that the marketplace `ref` is changing (or being set for the first time), naming both the previous value (`unset`, or whatever it was) and the new value it resolved to (a `v<semver>` tag, or `main` if no release exists yet).
- The written `.claude/settings.json` has `extraKnownMarketplaces.port.source.ref` set to a non-empty value (a `v<semver>` tag or `main`) and `extraKnownMarketplaces.port.autoUpdate` set to `true`.
- `enabledPlugins` and the pre-existing `permissions.allow` entry (`Bash(git status)`) both survive.
- The file is still valid JSON.

## Fail

Any of:

- `ref` is written or changed with no accompanying statement in words naming the previous and new values — a settings diff shown to the operator is not enough on its own.
- `ref` is left unset, empty, or set to a branch name that isn't `main` (e.g. `dev`, the integration branch) with no justification tied to "no release exists yet."
- `enabledPlugins`, `extraKnownMarketplaces`, or the pre-existing `permissions.allow` entry is dropped or emptied.
- The file is rewritten from a template rather than merged.

## Notes for the judge

- The run may not have network access to resolve a real release tag, or `b-at-neu/port` may have no published release at the time of the run — either is fine. What is graded is that whichever value it lands on (a tag or `main`) is named explicitly alongside the previous value, not written quietly.
- "Unchanged" is not the expected outcome here — the scaffold's entry starts ref-less, so any legitimate resolution changes it from `unset` to something concrete. A run that reports "unchanged" without ever having had a ref to compare against is a fail.
- Grade the words in the transcript and the file on disk together; a narration promising to report changes that then does not is a fail.
