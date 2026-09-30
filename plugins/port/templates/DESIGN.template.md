# Design Standards

<!--
  Installed by /port:init as a starting point, or written directly by
  /port:analyze once a repository's interface is real enough to document. Fill
  it in with this repository's actual tokens and treatments and delete what
  does not apply — an empty or aspirational section is worse than no section,
  because every stage agent that touches an interface reads this file and
  review cites it as a finding.

  Point `docs.design` in port.config.json at this file once it says something
  real. Leave that field null until then — and leave it null entirely for a
  repository with no interface, or barely any: a library, a CLI, or a three-
  section document padded to look complete is worse than none, because review
  will cite it anyway.
-->

Every stage agent working on interface work reads this document when `docs.design` is set: `plan-agent` designs UX states and copy against it, `impl-agent` builds to it, and `review-agent` cites it as a review dimension. When it is null, all three behave exactly as they do today — the plan, the ticket, and the surrounding code.

**Boundary with `ENGINEERING.md`.** `ENGINEERING.md` is how code is structured and what must be true of it — correctness, security, layering, error handling, testing. This document is what the interface looks like and the vocabulary for building it — tokens, typography, spacing, component treatments, responsive behaviour, copy tone. **Accessibility lives in `ENGINEERING.md` alone** — semantics, keyboard operability, focus management, labelling, contrast requirements — cross-referenced here and never restated. **Contrast is the one genuine overlap, resolved once**: the actual token values (which colors pass which ratio) are recorded here, as design vocabulary; the requirement that a pairing must pass a given ratio at all is a correctness rule review blocks on, and stays in `ENGINEERING.md`.

**Stack:** <!-- UI framework, styling approach (CSS-in-JS, Tailwind, plain CSS, a component library), and where tokens are declared, if they are declared at all -->

## 1. Tokens

<!-- Palette, spacing scale, type scale, radii, shadows, breakpoints — every rule
     here quotes the literal value and cites the file that declares it. "Use
     consistent spacing" is the failure mode this section exists to prevent: an
     adjective is not a rule, and a value with no citation cannot be checked.

     Two shapes, not one. A **declared** token — a Tailwind config, a theme
     file, a CSS custom property — is quoted and cited to its declaration. An
     **undeclared but consistent** value, a literal that recurs across files
     with nothing naming it, is quoted and cited to the files it recurs in,
     without inventing a name for it — giving it a name is a proposal, approved
     individually like any other. -->

## 2. Typography

<!-- Font families, sizes, weights, line heights — as values, cited to where
     each is set. -->

## 3. Layout and responsive behaviour

<!-- Grid or flex conventions, breakpoints, and how a layout adapts across
     them. -->

## 4. Component treatments

<!-- The states a component must render — default, hover, focus, active,
     disabled, loading, error — and the visual rule for each, cited to where
     it is implemented. Where two components disagree on a treatment, that is
     a flagged inconsistency like any other. -->

## 5. Motion and feedback

<!-- Transition durations and easing, what animates and what does not, and how
     the interface signals a pending or completed action. -->

## 6. Copy and tone

<!-- Voice, terminology to use or avoid, and how errors and empty states are
     worded. -->

## 7. Agent quick reference

<!-- Required, not optional — a generic quick reference here is the main way
     this document fails while looking complete. This is what plan-agent reads
     to design a state and what review-agent cites, exactly as ENGINEERING.md's
     own §8 is its highest-value section for the same reason. Keep it short
     enough to hold in mind and specific enough to act on. -->

- [ ]
- [ ]
