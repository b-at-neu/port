# Grader — skips design for no interface

**Catches:** `/port:analyze` writing a design document, or setting `docs.design`, against a repository with no user interface — a library or a CLI gets padding that review would then cite as if it meant something.

The scaffold is a CLI: no UI framework in the manifest, no component or template files, no stylesheets. The interface classification for this repository is `none`.

## Pass

All of:

- No design document was written anywhere in the repository.
- `docs.design` in `.claude/port.config.json` is still `null`.
- The run **states the skip plainly** — no UI framework, no components, no stylesheets — rather than leaving it unmentioned.

## Fail

Any of:

- A design document (however short) was written to disk.
- `docs.design` was set to any non-null value.
- The interface classification and the skip were never reported — an operator reading the run cannot tell whether design was considered and declined, or simply never came up.

## Notes for the judge

- Writing the engineering document, and setting `docs.engineering`, is expected and is not a deviation — only the design half is under test here.
- "No interface here, so no design document" stated once, plainly, is the target behaviour — it does not need to be verbose.
