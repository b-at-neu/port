# Engineering Standards

<!--
  Installed by /port:init as a starting point. Fill it in with this repository's
  actual conventions and delete what does not apply — an empty or aspirational
  section is worse than no section, because every stage agent reads this file and
  review cites it as a finding.

  Point `docs.engineering` in port.config.json at this file once it says something
  real. Leave that field null until then; the agents fall back to the plan and the
  surrounding code, which is honest, whereas a hollow standards document is not.
-->

Every pipeline agent reads this document before working. It defines the quality bar beyond what is obvious from the code. Plans must account for it per feature, implementations must follow it, and review findings may cite its sections the same way they cite the plan.

**Stack:** <!-- languages, framework, database, auth, styling, testing -->

## 1. Architecture

<!-- Layering and where things live. Be specific enough that an agent can place a new
     file without guessing: which directory holds data access, which holds business
     logic, which holds shared types. State the rule for when something moves from
     local to shared. -->

## 2. Data and integrity

<!-- Query and mutation conventions, transaction boundaries, migration discipline,
     where input is validated. -->

## 3. Security

<!-- How a request is authenticated, and how authorization is scoped so a caller
     cannot reach another user's data. What must never cross to a client. How
     development-only code is prevented from running in production. -->

## 4. User-facing completeness

<!-- What states every asynchronous surface must ship — loading, empty, error.
     The error model: which failures are shown to the user, which are raised as
     unexpected, and how the user is told. Include the decision test, if you have
     one, so agents classify failures the same way you would. -->

## 5. Accessibility

<!-- Semantics, keyboard operability, focus management, labelling, contrast. -->

## 6. Performance

<!-- Caching and invalidation, what may block a response, pagination and query cost. -->

## 7. Quality bar

<!-- Type strictness, exhaustiveness, naming, and comment discipline: when a comment
     earns its place and how long it may be. -->

## 8. Pre-pull-request self-check

<!-- The scannable list of problems that actually recur in this repository.
     impl builds to it, revise must not reintroduce it, and review uses it as its
     review dimensions. Keep it short enough to hold in mind and specific enough to
     act on — this is the section agents lean on most, so it earns its length. -->

- [ ]
- [ ]
