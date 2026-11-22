# Pipeline state in the app

The desktop app keeps each ticket's pipeline state in its own store. GitHub labels mirror that state for people and for the merge gate; the app never decides anything from them.

## The store

A per-repository local record on one machine (the app's user data) of each ticket's stage, claim, gates, review cycles and history. It is the source of truth for every app decision. A missing or corrupt file reseeds from labels. There is no sync between machines.

## The mirror

One-way, and written by the app after each store commit. It writes the whole set every time, so a hand edit is overwritten. A failed write is recorded, shown under Label problems and retried each poll. A merge writes `approved` on the pull request and on its ticket.

## The seven labels

| Key | Default name | Where | Meaning |
| --- | --- | --- | --- |
| `port` | `port` | every ticket and pull request | The pipeline owns this item |
| `planning` | `planning` | issue | A plan is being researched |
| `implementing` | `implementing` | issue | Implementation is underway |
| `reviewing` | `reviewing` | pull request, and its issue | Review is underway |
| `revising` | `revising` | pull request, and its issue | Fixes are underway; a branch refresh also shows as `revising` |
| `approved` | `approved` | pull request, and its issue | Findings are at or under the bar; a human merges |
| `needsYou` | `needs you` | issue or pull request | The pipeline is waiting on a person |

A pull request carries the last four states. Once a pull request exists, its issue mirrors the pull request's state.

`needs you` sits on top of the state and never replaces it. The plan gate is `planning` plus `needs you`, and `approved` never carries it.

## Overrides

`labels` (`port`, `needsYou`) and `states` (`planning`, `implementing`, `reviewing`, `revising`, `approved`) in `.claude/port.config.json` rename them. The casing is used verbatim and matching is case-insensitive. port never renames a label that already exists.

On an app-only repository, `CLAUDE.md` takes `labels.port`, `labels.needsYou` and `states.*` as well; see `PIPELINE.md` → "CLAUDE.md overrides".

## `appOnly`

`/port:init` sets `appOnly` in `.claude/port.config.json`, on a fresh init and when it migrates a repository from the old labels. `port-tick`, the cockpit's preflight and `/port:implement` refuse a repository with it set.

## Reading labels

No app decision reads a label. The exceptions are named:

- The merge gate workflow, which is the one decision a label makes.
- Seeding a repository the store has never seen, which adopts its labels once.
- A repository a terminal cockpit holds, whose labels are its record.
- The mirror, which diffs what it is about to write against what is there.

A layer 1 check in this repository pins the rule. A new label read is added to that check's sources with its reason, never silently.

Seeding is label-derived, and four of the old names (`planning`, `reviewing`, `revising`, `approved`) collide with display names. A repository that loses its store file can therefore come back with some tickets at an approximate stage.

## The terminal cockpit is legacy

`/port:pipeline`, `port-tick` and `/port:implement` are label-driven and GitHub-only. They run the 17-label vocabulary in `PIPELINE.md` → "Label lifecycle", and they refuse an app-only repository.
