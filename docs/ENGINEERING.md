# Engineering Standards

Every pipeline agent reads this before working. Plans account for it, implementations follow it, and reviews may cite its sections.

- This is this repository's own standards document. `plugins/port/templates/ENGINEERING.template.md` is the skeleton `/port:init` installs elsewhere, so concrete paths like `plugins/port/**` are correct here only.
- §1–§8 cover the plugin, `scripts/` and shared code. §9 covers `apps/desktop` and wins where they overlap.
- Where things live is [ARCHITECTURE.md](../ARCHITECTURE.md)'s job, not this document's.
- Cite checks by their `// --- ` block name and docs by heading, never by line number.

**Stack:** Markdown agent and skill definitions (the product) · Node.js ESM scripts in TypeScript, type-stripped, zero runtime dependencies, at or above `engines.node` · JSON Schema draft 2020-12 · GitHub Actions · `gh` for all GitHub I/O · a pnpm workspace with TypeScript, Electron and zod (`apps/desktop`)

## 1. Architecture

`plugins/port/docs/PIPELINE.md` is the single source of truth for operating rules, the label lifecycle, the permission model and every output format. Agents and skills restate only what is unique to them. A rule shared by several files goes in as a byte-identical block with a pin (§2).

- **Pure logic apart from I/O.** `hooks/lib/guard-rules.mjs` holds the pure, unit-tested decisions; `hooks/agent-guard.mjs` is the thin stdin/stdout wrapper, tested by spawning it. The worktree reclamation script follows the same split. New logic goes in the library.
- **`scripts/checks.ts` only wires.** It discovers every `scripts/checks/<topic>.ts`, runs each, then calls `report()`. A new check goes in its topic module, never the runner. Assert with `expect(cond, check, detail)`; use `fail`/`ok` only when the logic branches. `scripts/lib/report.ts` decides nothing; `scripts/lib/files.ts` holds the shared file helpers.
- **In `scripts/`,** every `catch` uses `message(e)` from `scripts/lib/errors.ts`. JSON from `readJson` stays `any`; config shape comes from the schema, never a hand-written interface.
- **The trajectory record is write-only.** `scripts/port-tick/events.ts` exports nothing named `read*`/`parse*`, and only `port-tick.ts` and `report.ts` may import it or `report.ts`.
- **A file an adopter copies alone is self-contained.** `plugins/port/bin/*.mjs` have no relative imports and must work on Windows (no `execSync`, no `shell: true`). This is why §7's line limit exempts `bin/`.
- **`plugins/port/` is one contract per directory:** `templates/` holds fill-in templates only, `bin/` self-contained executables only, `data/` canonical data only (`labels.json`, `labels.legacy.json`; the desktop app keeps its own copies under `apps/desktop/src/utils/labels/`).
- **No repository-specific literal in prompt text.** Label, check and branch names and the repository slug come from `.claude/port.config.json` or PIPELINE.md's default table. Test: would it work in a freshly `/port:init`-ed repository with renamed labels, one branch and different CI checks?
- **Shipped files reference only shipped paths.** Nothing under `plugins/port/` may point at `docs/USAGE.md`, `CONTRIBUTING.md`, `scripts/` or other repository-only files.
- **Under root `scripts/`, cross-folder imports use the `imports` map** (`#lib/…`, `#port-tick/…`, `#plugins/…`, `#desktop/…`), never `../`.

## 2. Data and integrity

- `.claude/port.config.json` validates against `schema/port.config.schema.json`, generated from `apps/desktop/src/main/repos/config/schema.ts` by `pnpm --filter @port/desktop schema:config` and never hand-edited.
- Schema fixtures come in pairs: `valid.*.json` must pass and `invalid.*.json` must fail, both asserted.
- **Duplicated content gets a mechanical pin in both directions, added in the same commit as the copy.** A "keep in sync" comment is not a pin.
- **Config shape is asserted, not assumed** (e.g. `commands.checks` entries are `{run, fix}` objects, never bare strings).

## 3. Security

- **Broad allow, authoritative deny.** Allow whole dev-command categories; the deny list is the safety surface, and deny beats allow. A permission change updates both `templates/permissions.base.json` and PIPELINE.md's permission model.
- **The `PreToolUse` guard hook is the enforcement.** `permissionMode: dontAsk` is declared intent only. When a denial matters, change and test the hook.
- **Some rails apply to every caller,** the cockpit included: no `gh`/`git` in a shell loop, no clearing `<labels.needsHuman>` without a recent operator message naming the item, and no plugin install or marketplace change from inside a worktree.
- **`sessionRequiredPaths` cannot be crossed by a dispatched agent** or granted back by settings. Such plans route to `/port:implement`; in the desktop app, the edit pauses for operator approval.
- **A hook returns immediately outside a port-managed repository.**
- **A hook records a harness decision; it never re-derives one.**
- **Known gaps stay documented:** shell redirection through an allowed command cannot be denied by pattern, and a native `permissions.deny` match is not logged. Writing files with Write/Edit is a convention, not a guarantee.

## 4. Operator-facing completeness

Every plan, review, comment and cockpit line is user-facing.

- **Writing style** (FORMATS.md → "Writing style"): short bullets, one idea each · reference context, don't restate it · omit empty sections, no "N/A" · no meta-commentary · say each point once.
- **Every failure mode states which direction it fails toward, and why.** Existing choices:
  - `SESSION REQUIRED` detection fails open toward dispatch.
  - The tick fails closed on actions, never on reporting, and still schedules the next wakeup.
  - The CI merge gate fails open on an unlabelled pull request.
  - A `CLAUDE.md` override fails closed on the entry and open on the run. The desktop app instead fails the whole repository closed on an unreadable file (`effective-config-unreadable`).
- **A blocked or denied action is reported, never retried or routed around:** `BLOCKED: <exact denied command + what you needed>`, then stop.
- **An absent signal is never a passing one.** An empty check rollup is pending; no verdict while any head-commit check is pending or the PR is `CONFLICTING`. Liveness is a `TaskList` call, never a label. Parse a GraphQL envelope in full: `errors` can sit beside usable `data`, only aliases named in `errors[].path` are unavailable, and never filter a GraphQL call with `--jq`.
- **A denial log's line count is not a denial count,** and an unresolvable session id reports `unknown-session`, never a guessed role. Reconcile a capped read's groupings against `window`, not `summary`.
- **A transcript's recency is activity, never liveness.** No `running`/`alive`/`isLive` field from file reads; a stall is a report, never proof.
- **A path is not evidence.** Resolve a derived fact (e.g. the install record's commit sha) rather than pattern-matching a string.
- **Large or fenced markdown never goes inline to `gh`.** Write it under `.temp/` and pass `--body-file` or `--input`.

## 5. Accessibility

- **Label colour:** hue encodes the pipeline phase, lightness the position. One palette per phase, the same hue on GitHub, the Board pill and the sidebar dot. Needs-you gates stay two steps apart (`DC2626` → `991B1B`). `scripts/checks/phase-palette.ts` enforces contrast; colours are six-digit uppercase hex and distinct.
- **Severity is never colour-only:** 🔴 Critical · 🟠 Medium · 🟡 Low · ⚪ Nit.
- **Desktop screens meet WCAG AA,** built to `docs/DESIGN.md`:
  - Text at least 4.5:1; focus rings and status dots at least 3:1 (`DESIGN.md` §1).
  - Every pill and phase carries its name in text; the phase bar has a tooltip.
  - Everything is keyboard-reachable with a visible focus ring; an icon-only button has a tooltip and an accessible name.
  - No text under 11px, no click target under 24px.
  - Reduce-motion turns off every transition and the attention pulse.

## 6. Performance

- **Cost is measured, then reduced, then pinned.** The tick is one aliased `gh api graphql --include` call; a per-label poll fails layer 1. The desktop poll is a two-connection sweep plus a per-number detail read (5 points), never per-label connections.
- **Desktop polling has two tiers:** a 60s full sweep, plus a 10s issues-list ETag pre-check that triggers an early sweep on change. Sweeps stretch so projected hourly use across all repositories stays under half the reported limit; a unit test recomputes this from the constants.
- **The cockpit pacing ladder** holds at a 270s floor while something can progress on its own, otherwise backs off 270 → 540 → 1080 → 1800 and resets on any change. It never stops scheduling wakeups while it owns the checkout, except once `.agents/cockpit.json` reads `app` or `unreadable`, when it reports and stops.
- **No busy-waiting.** Bounded waits use a real timeout and a capped retry count; no bare `sleep`.
- **Expensive work runs in proportion to what changed.** Evals and the layer 2 audit never enter `commands.checks`, since impl-agent runs that list before every push.

## 7. Quality bar

- **Comments are rare and one line,** explaining only a non-obvious constraint or why. Never restate code or cite a ticket. The comment ratchet (`scripts/checks/comments.config.json`) may only be lowered; a new file must be clean.
- **No dead scaffolding, transitional shims or placeholders for a later ticket.**

**A source file is at most 500 lines.** An over-limit file is split by topic, and the allowlist in `scripts/checks/file-size.config.json` records current counts and may only shrink. Each exclusion is mirrored by an `exclude` entry there:

- `pnpm-lock.yaml` — generated.
- `schema/fixtures/**` — the content is the thing under test.
- `plugins/port/bin/**` — copied alone into adopters (§1), so it cannot be split.

- **`scripts/` runs `noUncheckedIndexedAccess: false` deliberately;** `apps/desktop` runs it on. `tsconfig.scripts.json` sets `erasableSyntaxOnly` (no `enum`/`namespace`/parameter properties) and `allowImportingTsExtensions`.
- **A check that cannot fail is not a check.** Assert every validator against a passing and a failing example, and break each new rule once on purpose.
- **A check must distinguish the state it exists to detect.** Prefer one whose failure you have observed.
- **In the plugin and `scripts/`, a fixed regression leaves a layer 1 guard,** and duplicated content leaves a pin. A prose-only prompt fix is incomplete. In `apps/desktop`, a fixed decision regression leaves a table case or scenario test, never a source-text check.
- **Rails are checkable preconditions,** never bare "never do X" prose.
- **Component frontmatter is exact:** `name` equals the agent's basename or the skill's directory name; `description` is non-empty.
- **Evals:** one behaviour per case · apply pressure · grade the artifact, not the narration · name the failure at the top of the grader.
- **Commit subjects are `#<issue> <imperative lowercase summary>`,** under 80 characters, no trailing period, `#0` with no issue. Commit with `git commit -F <file>`, never `-m`.

## 8. Pre-pull-request self-check

- [ ] Checkout is current: `git rev-list --count HEAD..origin/dev` is `0`.
- [ ] Changed agents/skills have exact frontmatter.
- [ ] A touched Bash-granting agent's shell-discipline, label-cas and standards-precedence blocks still match PIPELINE.md byte for byte.
- [ ] No literal label, check, branch name or slug in prompt text.
- [ ] New duplication has its pin; changed pinned files still agree in both directions.
- [ ] New checks were made to fail once and live in their topic module; fixed regressions left a guard.
- [ ] New rails are checkable; new failure modes name their direction.
- [ ] No absent signal read as success; no derived fact inferred from a path or label; no decision taken from a label.
- [ ] Files an adopter copies alone have no relative imports and work on Windows.
- [ ] No inline markdown `--body`; `.temp/` + `--body-file` instead.
- [ ] `ARCHITECTURE.md` reflects new paths; shipped files reference only shipped paths.
- [ ] Comments are one line, explain a why and cite no ticket.
- [ ] `node scripts/checks.ts` and `pnpm typecheck:scripts` pass.
- [ ] No `.ts` file under `plugins/port/`.
- [ ] Commit subjects follow §7.
- [ ] No file crossed the line limit, and no allowlisted file grew.

## 9. Desktop app

Applies to everything under `apps/desktop`. Older code is migrated by the simplification tickets. A change follows the pattern for what it touches and never adds a new instance of an old shape.

### Layout

Each rule is an ESLint rule in `apps/desktop/eslint.config.mjs`.

- Main-process features in `main/features/<feature>/`, platform adapters in `main/platform/`, the composition root in `main/app/`.
- `main/<dir>/` imports only the layers listed for it; `app/` and `main/index.ts` are the only composition roots and import anything. The `LAYERS` table in `eslint/boundaries.mjs` is the source, and each row is the `layer-<dir>` rule:
  - `platform` imports `platform`.
  - `repos` imports `platform`, `repos`.
  - `github` imports `platform`, `repos`, `github`.
  - `sessions` imports `platform`, `repos`, `sessions`.
  - `pipeline` imports `platform`, `repos`, `github`, `sessions`, `pipeline`.
  - `dispatch` imports everything `pipeline` does, plus `dispatch`.
  - `worker` imports everything `pipeline` does, plus `worker`.
  - `features` imports every layer except `worker`; from `app` only `define`, `schemas` and `context`, and from `platform` only `paths`, `json-store` and the index type.
- Renderer screens in `renderer/pages/<page>/`; shared pieces in `renderer/components/` and `renderer/data/`.
- Code shared by both processes is pure and lives in `utils/`. `types/` holds only types with no runtime schema.
- Cross-folder imports use `@/<top-level>/…`, never `../`.
- `src` imports nothing from `scripts/` or `plugins/`. The renderer imports nothing from `main/`, and no page imports another page.

### Patterns

- **Action.** `main/features/<feature>/actions/<verb>.ts`, named `'<feature>.<verb>'`, built with `defineAction({ name, kind, input, run(ctx, input) })`. Input is validated before `run`. It imports its own feature, `utils/`, `types/` and other features' `index.ts`, never `electron`, `node:*` or `main/platform/`; I/O goes through `ctx`. The router derives channels, types, the preload bridge and validation.
- **AppContext.** One object built in `main/app/`, holding the platform adapters, every store and the repository registry. Only adapters import `node:fs`, `node:child_process`, `fetch`, `electron-updater` and the Agent SDK. No `*Deps` interface outside an adapter, no factory that only pre-binds dependencies. Tests build an in-memory AppContext; fixture mode swaps adapters only.
- **Tracker.** Issue reads, comments, labels read back and the plan-body write go through `ctx.tracker`. Only `main/github/tracker/` names an issue query, and only the composition roots build a tracker. ESLint enforces both.
- **JsonStore.** `createJsonStore({ file, version, schema, migrate })` is the only JSON persistence: one file per store, a zod schema, a pure `migrate`, atomic writes through `ctx.fs`. Each store states what a missing, malformed or newer file loads as, and which way that fails (§4).
- **Transition.** A pure `(ticket, event) → ticket | refusal` table keyed on status × event. The commit refuses a stale `rev`; a transition applies only once persisted. Imports only `utils/` and its feature's types.
- **Domain table.** One `utils/stages.ts` defines stage, phase, column and needs-you kind for both processes. Nothing else re-derives them. Imports only zod and `types/`.
- **Page.** `page.tsx` (composition), `model.ts` (pure, no React or data hooks), `copy.ts` (every string), `components/` (local). Built on `<Page>`, which owns loading, error and empty states. Data comes only through the typed action hooks.
- **Operator action.** Every write button uses `useActionMutation(name, { confirm, toast, invalidates })`, confirms with `<ConfirmDialog>`, and shows a typed `{ ok: false }` reply as data. Only a rejected invoke is an error.
- **Zod** is the only schema library. Types come from `z.infer`, never declared twice. The config JSON Schema is generated from zod.

### Split rule

- §7's 500-line limit is hard here too.
- Split along a pattern boundary (one action, store, table or page component), never by line count.
- A comment saying a file was split to stay under the limit fails review.

### Tests

- Table-driven tests for pure decisions; scenario tests through an in-memory AppContext for flows, asserting final state.
- Never pin UI copy, assert mock call order, or read source text.
- Add a test only when adding or changing a decision. Guideline: test lines about 10% of source lines; branch coverage gates the pure pipeline modules.

### Checks

- No new `scripts/checks` module asserts on `apps/desktop` source text; layering rules go in ESLint.
- `ghWrite` is read only in `main/github/writes/`, `main/platform/` and `main/worker/engine.ts`; the `githubHttp`, `githubConditional` and `githubPublic` members only in `main/github/`, `main/platform/` and `main/worker/engine.ts`. Everything else takes a narrow ctx.
- Remove duplication rather than pinning it. An unavoidable copy (bundled data) is pinned by a test or a type.
- Only the safety properties below may be checked by desktop path.

### Safety properties

- Labels are a display mirror written after the ticket record commits; no decision reads one.
- Only the write adapter writes to GitHub, and never runs merge, close, `--delete-branch` or ready.
- The GitHub token stays in main-process memory.
- Main holds exactly one clock.
- A stall is a report, never proof, and is suppressed when its evidence is older than one poll plus grace.
- The renderer never sets HTML from text, and links are `http(s)` only.
- The renderer uses no `useEffect` or `useLayoutEffect`.
- Colour comes only from theme roles.
- Fixture data replaces adapters only, never decision logic, and a release build carries none.
- Stage-session instructions come from the app's own `stage-prompts/`, and a stage session never writes a label.

### Desktop self-check

- [ ] Every call, store, transition, table, page and write button uses its pattern.
- [ ] No file is over the limit or split by line count.
- [ ] Tests were added only for added or changed decisions.
- [ ] No new check asserts on desktop source text.
- [ ] Every safety property still holds.
