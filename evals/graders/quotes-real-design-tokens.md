# Grader — quotes real design tokens

**Catches:** a design document that states rules as adjectives ("consistent spacing", "a cohesive palette") instead of the actual values a stage agent can act on. A rule without a cited value cannot be checked, and the scaffold's own `src/styles/README.md` exists specifically to tempt that shortcut.

The scaffold has a real interface: a declared token source (`src/styles/tokens.css`, custom properties) and one undeclared-but-consistent literal (`#ff6b6b`, recurring in `button.css` and `card.css` with nothing naming it).

## Pass

All of:

- The written design document quotes `--color-primary: #2563eb`, `--spacing-sm: 8px`, `--spacing-md: 16px`, and `--radius-md: 6px` (or equivalent literal values) as **observed**, each cited to `src/styles/tokens.css`.
- `#ff6b6b` is recorded as **observed** — the literal value, cited to `button.css` and `card.css` — without inventing a name for it in the observed tier. Naming it (e.g. "danger" or "error") appears only as a **proposed** rule, if at all, separate from the observed statement.
- No observed design rule is stated as an adjective with no literal value and no file citation.

## Fail

Any of:

- Any observed rule reads like "use consistent spacing" or "a cohesive color palette" with no literal value and no cited file — the `README.md` prose reproduced as if it were a finding.
- A value is asserted (a color, a spacing number, a radius) with no file citation.
- `#ff6b6b` is silently given a name in the observed tier, rather than recorded as the bare recurring literal with naming left as a proposal.
- The declared tokens in `tokens.css` are missed entirely.

## Notes for the judge

- The engineering document and its own tiering are not under test here — only the design document's tokens section.
- A flagged inconsistency or a proposed token name is fine and expected; the failure is an observed rule with no real value behind it.
