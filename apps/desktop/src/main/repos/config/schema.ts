// The one definition of `.claude/port.config.json`. `schema/port.config.schema.json` is generated from it by `pnpm --filter @port/desktop schema:config`; never edit that file by hand.
// Self-contained on purpose: it imports only zod, so plain Node can load it for the generator.
import { z } from 'zod'
import type { SchemaViolation } from '@/utils/repos'

/** The one home of each default, used by the schema below and by every consumer. */
export const CONFIG_DEFAULTS = {
  branches: { integration: 'dev', production: 'main' },
  models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
  modules: { approvalGate: true, release: true, scope: true },
  reviewCycleCap: 5,
  commands: { worktrees: null, budget: null, tracker: null },
  concurrency: { sharedFiles: [] as readonly string[], overlapThreshold: 2 },
  /** The port's own seed for a `sessionRequiredPaths +=` override — nothing else in the app consumes the resolved list. */
  sessionRequiredPaths: ['CLAUDE.md', '.claude/**'] as readonly string[],
  release: { versionSource: 'tags', versionFiles: [] as readonly string[], versionCommand: null, postPublishHook: null },
} as const

const nonEmpty = z.string().min(1)
const nullableString = (description: string, example?: string) => z.string().nullable().default(null).meta({ description, ...(example === undefined ? {} : { examples: [example] }) })
const stringList = (description: string, example?: readonly string[]) =>
  z.array(nonEmpty).default([]).meta({ description, ...(example === undefined ? {} : { examples: [example] }) })

const stateLabel = (description: string, fallback: string) => nonEmpty.default(fallback).meta({ description })

const commandsSchema = z
  .strictObject({
    bootstrap: stringList(
      'Commands that make a fresh checkout workable, run in order, one per shell invocation. Typically a dependency install and any code generation. Empty when a checkout needs no preparation.',
      ['npm ci', 'npm run prisma:generate'],
    ),
    checks: z
      .array(
        z.strictObject({
          run: nonEmpty.meta({ description: 'The command that reports pass or fail.' }),
          fix: z.string().nullable().default(null).meta({ description: 'Command that repairs what `run` reports, when one exists. Null for checks nothing can auto-fix, such as type checking.' }),
        }),
      )
      .default([])
      .meta({
        description:
          'The checks that must pass before a pull request is opened, run in order. An agent runs `run`; on failure it runs `fix` when one is given and retries once.',
      }),
    artifacts: nullableString(
      'Command prefix the stage agents append `check <kind> <file>` (production-time artifact validation) and the layer 2 audit appends `audit` to. Null when the repository has no Node, in which case agents produce the artifact format but nothing validates it locally.',
      'node scripts/port-artifacts.mjs',
    ),
    worktrees: nullableString(
      'Command prefix the cockpit appends `report`/`reclaim` to for worktree reclamation, and that `/port:worktree-clean` drives interactively. Null means hygiene is unavailable — worktrees still accumulate under `.claude/worktrees/` per ticket, and the cockpit says so once at startup rather than silently doing nothing.',
      'node scripts/port-worktrees.mjs',
    ),
    budget: nullableString(
      'Command prefix the cockpit appends `reset`/`dispatch`/`sweep`/`report` to for per-ticket dispatch cost accounting. Null means nothing measures or bounds ticket cost, and the cockpit skips it silently — `reviewCycleCap` still bounds review loops only.',
      'node scripts/port-budget.mjs',
    ),
    tracker: nullableString(
      'Command prefix `/port:scope` appends `create`/`link-child`/`block` to, which creates tickets on whichever vendor `tracker` names. Null means `/port:scope` refuses to create tickets.',
      'node scripts/port-tracker.mjs',
    ),
    tick: nullableString(
      "Command prefix the cockpit appends `start`/`plan`/`commit`/`resolve` to for the tick engine, which moves the tick's decisions (query build, envelope classification, ownership partition, label classification, mergeability/contention/cycle-cap/liveness routing, and the pacing ladder) out of prose and into a deterministic script. Null means the cockpit follows the prose tick procedure in `TICK-PROSE.md` instead.",
      'node scripts/port-tick.mjs',
    ),
    forensics: nullableString(
      "Command prefix the operator and the cockpit-tick housekeeping sweep append `report` to for the forensics engine, which asserts on what a dispatched agent's transcript actually shows (terminations, missing task-notifications, orphaned in-flight labels, shell loops, Bash timeouts, and BLOCKED: compliance after a denial) rather than only on the artifacts a run leaves behind. Reads a machine-local transcript tree outside the repository, so it is never run from `commands.checks`. Null means the repository has no forensics engine wired up, and the cockpit skips it silently.",
      'node scripts/port-forensics.mjs',
    ),
    screenshots: z
      .strictObject({
        run: nonEmpty.meta({ description: 'The command that writes the captures.' }),
        dir: nonEmpty.meta({ description: 'Repo-relative directory the captures are written to.' }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The repository's own screenshot harness, which `impl-agent` runs once, verbatim, when the plan has a `## UX states` section, then publishes the chosen captures into the pull request's `## Screenshots`. `run` is allowlisted like any `commands.*` entry — cover it in `extraAllow` when the base list does not — and must never go in `commands.checks`, since it may launch a display-bound app. `dir` is the repo-relative directory the PNGs land in. Null means no capture, and the pull request says so.",
        examples: [{ run: 'pnpm screenshots', dir: 'out/screenshots' }],
      }),
  })
  .meta({ description: 'Shell commands the implementing agents run. Every entry must start with its binary and parse cleanly, or the permission allowlist will not match it.' })

const rest = {
  branches: z
    .strictObject({
      integration: nonEmpty.default(CONFIG_DEFAULTS.branches.integration).meta({ description: 'Branch that feature pull requests target and that agents rebase onto.' }),
      production: nonEmpty
        .nullable()
        .default(CONFIG_DEFAULTS.branches.production)
        .meta({
          description:
            "Branch that releases promote to. Agents never open a feature pull request against it. Null means this repository has one long-lived branch and no release flow — prefer null over repeating `integration`'s name, which reads as a mistake at every use site.",
        }),
    })
    .meta({
      description:
        "The repository's long-lived branch(es). Feature work always targets `integration`. `production` is only ever reached by a release, or is null for a repository with no separate production branch — see the root allOf conditional pairing null `production` with `modules.release: false`.",
    }),
  docs: z
    .strictObject({
      engineering: nullableString('Path to the engineering standards every stage agent reads before working, and that review treats as a review dimension.', '.claude/docs/ENGINEERING.md'),
      design: nullableString(
        'Path to the design standards plan-agent, impl-agent, review-agent, and revise-agent read for interface work, with review treating it as a review dimension. Null means the repository has no interface, or not enough of one to document — the agents fall back to the plan and the surrounding code.',
        '.claude/docs/DESIGN.md',
      ),
    })
    .meta({ description: 'Repository-authored documents the agents read. Null means the repository has none, and the agents fall back to the plan and the surrounding code.' }),
  models: z
    .strictObject({
      plan: nonEmpty.default(CONFIG_DEFAULTS.models.plan).meta({ description: 'Stage 1. Defaults to the strongest model because planning quality amplifies through every later stage.' }),
      impl: nonEmpty.default(CONFIG_DEFAULTS.models.impl).meta({ description: 'Stage 2, which writes the bulk of the code.' }),
      review: nonEmpty.default(CONFIG_DEFAULTS.models.review).meta({ description: 'Stage 3, which must catch real problems reliably.' }),
      revise: nonEmpty.default(CONFIG_DEFAULTS.models.revise).meta({ description: 'Stage 4, which applies a structured list of findings.' }),
    })
    .meta({
      description:
        "Which model runs each stage. Accepts an alias (`opus`, `sonnet`, `haiku`, `fable`), `inherit` to use the session's model, or an exact model id. Also determines the co-authorship trailer on commits an agent makes.",
    }),
  labels: z
    .strictObject({
      port: stateLabel('Marks an item as pipeline-owned.', 'port'),
      needsYou: stateLabel('Gate: the pipeline is waiting on a person.', 'needs you'),
    })
    .meta({
      description:
        'Overrides for the two non-state labels the port app writes. The casing is used verbatim, and reads match case-insensitively. An omitted key uses the standard name shown as its default; override only where a repository already uses a different word.',
    }),
  states: z
    .strictObject({
      planning: stateLabel('In flight: a plan is being researched.', 'planning'),
      implementing: stateLabel('In flight: implementation underway.', 'implementing'),
      reviewing: stateLabel('In flight: review underway.', 'reviewing'),
      revising: stateLabel('In flight: fixes underway.', 'revising'),
      approved: stateLabel("Terminal: findings are at or under the current cycle's bar; a human merges.", 'approved'),
    })
    .meta({ description: 'Overrides for the five state labels. The casing is used verbatim, and reads match case-insensitively. An omitted key uses the standard name shown as its default.' }),
  modules: z
    .strictObject({
      approvalGate: z
        .boolean()
        .default(CONFIG_DEFAULTS.modules.approvalGate)
        .meta({
          description:
            'Enforce the merge gate in CI. When off, no workflow is installed and review still applies the approved label, but the merge gate is conversational rather than enforced. Leave it off unless a branch ruleset makes the check required, since otherwise the workflow is noise.',
        }),
      release: z.boolean().default(CONFIG_DEFAULTS.modules.release).meta({ description: 'Offer the release flow that promotes integration to production and publishes a tagged release.' }),
      scope: z.boolean().default(CONFIG_DEFAULTS.modules.scope).meta({ description: 'Offer the stage-zero flow that decomposes a feature into an epic with dependency-ordered sub-issues.' }),
    })
    .meta({
      description:
        'Optional subsystems. Turning one off removes it entirely: its labels are never created, its queries never run, and the agents carry no instructions about it.',
    }),
  release: z
    .strictObject({
      versionSource: z
        .enum(['tags', 'package'])
        .default(CONFIG_DEFAULTS.release.versionSource)
        .meta({
          description:
            'Where the canonical version number lives. `tags` means git release tags are the only record, so there is no version file to bump and the release flow opens one pull request rather than two. `package` means a manifest in the repository carries it, and the flow opens a version-bump pull request first.',
        }),
      versionFiles: stringList(
        'Files the version bump edits, in order, when `versionSource` is `package`. Typically a manifest and its lockfile. Ignored for `tags`.',
        ['package.json', 'package-lock.json'],
      ),
      versionCommand: nullableString(
        'Command that writes the new version into `versionFiles` without committing or tagging, with `{{version}}` substituted. Null means edit the files directly instead. Ignored for `tags`.',
        'npm version {{version}} --no-git-tag-version --allow-same-version',
      ),
      postPublishHook: nullableString(
        "A `node` invocation run verbatim, once, with no appended arguments, immediately after `/port:release` publishes the tag and GitHub release — the same command-prefix convention `commands.artifacts`/`worktrees`/`budget`/`tick` already follow. It resolves everything it needs from the repository itself. Must be idempotent: both Phase B's own step and the 'Done' exit run it, so a run that died after `gh release create` still completes. A non-zero exit is reported and never retried — the release has already shipped by the time the hook runs. Null means skip silently.",
        'node scripts/port-release-hook.mjs',
      ),
    })
    .meta({ description: 'Configures the release flow. Whether that flow is offered at all is `modules.release`; these settings only shape it once it is.' }),
  budget: z
    .strictObject({
      wallClockMinutes: z
        .int()
        .min(1)
        .nullable()
        .default(null)
        .meta({
          description:
            'Ceiling on cumulative agent wall-clock per ticket. At or over it, `commands.budget dispatch` returns `exceeded` and the cockpit escalates to `<labels.needsHuman>` instead of dispatching, the same shape `reviewCycleCap` already uses.',
        }),
    })
    .meta({
      description:
        'The per-ticket dispatch cost rail. Null `wallClockMinutes` means unbounded — nothing changes for a repository that does not opt in. Whether this is enforced at all is `commands.budget`; this block only shapes it once that is set.',
    }),
  concurrency: z
    .strictObject({
      sharedFiles: stringList(
        "Paths that never contribute to a hold, in either direction. Uses the `## Changes` grammar, not glob syntax: repo-relative, forward-slashed, no leading `./`, case-sensitive, and a trailing `/` matches any path beneath it — deliberately different from `sessionRequiredPaths`' `**` globs, since this list is compared against claimed paths written in that same grammar. List a path only when two tickets both touching it produce a union the rebase protocol already auto-resolves — a registry, an index, a table, a wiring file. A path where two tickets would edit the same key, the same constant, or the same paragraph does not belong here.",
      ),
      overlapThreshold: z
        .int()
        .min(1)
        .default(CONFIG_DEFAULTS.concurrency.overlapThreshold)
        .meta({
          description:
            "How many non-excused paths one in-flight item must share with a candidate before it holds. Counted per in-flight item, never pooled. `1` restores the pre-#190 behaviour of holding on any shared path.",
        }),
    })
    .meta({
      description:
        'Narrows the file-contention gate from any shared path to enough shared paths that a rebase probably escalates. Absent means both defaults apply.',
    }),
}

export const configSchema = z
  .strictObject({
    $schema: z.string().optional().meta({ description: 'Optional pointer to this schema, for editor completion and validation.' }),
    tracker: z
      .enum(['github'])
      .default('github')
      .meta({
        description:
          "Which issue tracker the pipeline's tickets live on and the app mirrors state onto. Only GitHub is implemented; this field exists so a second backend can be added without a breaking change.",
      }),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
      .meta({
        description: 'The GitHub repository this pipeline operates on, as `owner/name`. Every `gh` call the agents make is scoped to it.',
        examples: ['b-at-neu/portfolio'],
      }),
    branches: rest.branches.optional(),
    commands: commandsSchema.optional(),
    docs: rest.docs.optional(),
    models: rest.models.optional(),
    labels: rest.labels.optional(),
    states: rest.states.optional(),
    appOnly: z.boolean().default(false).meta({ description: 'Set by `/port:init` when the repository moves to the app vocabulary. The terminal cockpit refuses a repository with this set.' }),
    modules: rest.modules.optional(),
    release: rest.release.optional(),
    reviewCycleCap: z
      .int()
      .min(1)
      .default(CONFIG_DEFAULTS.reviewCycleCap)
      .meta({ description: 'How many review cycles may run before the pipeline stops and asks for a human. Counted from the review comments on the pull request.' }),
    budget: rest.budget.optional(),
    concurrency: rest.concurrency.optional(),
    sessionRequiredPaths: z
      .array(nonEmpty)
      .default([...CONFIG_DEFAULTS.sessionRequiredPaths])
      .meta({
        description:
          'Globs that cannot be handed to a dispatched agent, because the harness denies edits under them to subagents. A plan touching any of these is marked so the operator runs that stage in their own session instead. Also seeds the never-touch list for automatic rebase conflict resolution.',
      }),
    extraAllow: z
      .array(nonEmpty)
      .default([])
      .meta({
        description:
          "Additional permission patterns merged into the repository's allowlist by the installer, for tooling the base list does not cover. An entry covering a `commands.*` command ends in ` *` (#205) — the matcher treats anything else as whole-command-exact, so a bare form denies every invocation an agent appends output-limiting flags to. Keep these narrow otherwise: the allowlist is the safety surface, and a broad entry can hand an agent a general command-execution escape hatch.",
        examples: [['Bash(npx shadcn@latest *)']],
      }),
  })
  .check((ctx) => {
    const value = ctx.value
    if (value.branches !== undefined && value.branches.production === null && value.modules?.release !== false) {
      ctx.issues.push({ code: 'custom', input: value, path: ['modules', 'release'], message: 'must be false when branches.production is null' })
    }
  })

const SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema'

/** Kept in the published schema so the file stays the cross-language contract for the editors and `check-jsonschema`; the same rule is enforced above by the zod check. */
const NULL_PRODUCTION_RULE = {
  $comment:
    "Root allOf: a null branches.production (single-branch mode) requires modules.release to be explicitly false, since release defaults to true and a config saying nothing would otherwise ask for both. Draft 2020-12 cannot compare two sibling values, so 'production must differ from integration' is NOT expressed here — /port:init's pre-write validation and layer 1's coherence check (comparing resolved defaults) enforce that instead.",
  allOf: [
    {
      if: { required: ['branches'], properties: { branches: { required: ['production'], properties: { production: { type: 'null' } } } } },
      then: { required: ['modules'], properties: { modules: { required: ['release'], properties: { release: { const: false } } } } },
    },
  ],
}

/** Rewrites zod's `anyOf: [{ type: T, … }, { type: 'null' }]` to the `type: [T, 'null']` form, which is what the published contract and its readers use. */
function foldNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(foldNullable)
  if (typeof node !== 'object' || node === null) return node
  const record = node as Record<string, unknown>
  const { anyOf, ...rest } = record
  const branches: readonly unknown[] = Array.isArray(anyOf) ? (anyOf as unknown[]) : []
  if (branches.length === 2) {
    const nullBranch = branches.find((branch) => typeof branch === 'object' && branch !== null && (branch as Record<string, unknown>).type === 'null')
    const other = branches.find((branch) => branch !== nullBranch) as Record<string, unknown> | undefined
    if (nullBranch !== undefined && other !== undefined && typeof other.type === 'string') {
      const { type, ...constraints } = other
      return foldNullable({ ...rest, ...constraints, type: [type, 'null'] })
    }
  }
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, foldNullable(value)]))
}

/** The published `schema/port.config.schema.json`, generated rather than hand-written. `io: 'input'` keeps every field that has a default optional. */
export function buildConfigJsonSchema(): Record<string, unknown> {
  const entries: [string, unknown][] = Object.entries(z.toJSONSchema(configSchema, { target: 'draft-2020-12', io: 'input' }))
  const body = foldNullable(Object.fromEntries(entries.filter(([key]) => key !== '$schema'))) as Record<string, unknown>
  return {
    $schema: SCHEMA_DRAFT,
    $id: 'https://raw.githubusercontent.com/b-at-neu/port/main/schema/port.config.schema.json',
    title: 'port.config.json',
    description:
      'Per-repository configuration for the port agent pipeline. Committed at `.claude/port.config.json` and read at runtime by every stage agent and skill, so it travels into worktrees and is reviewable in pull requests. Only `repo` is required; every other field has a documented default. Note that `default` here is documentation, not behaviour — JSON Schema does not populate values, so each consumer applies these defaults itself when a key is absent.',
    ...body,
    ...NULL_PRODUCTION_RULE,
  }
}

type Issue = z.core.$ZodIssue

const pointerOf = (path: readonly string[]): string => (path.length === 0 ? '(document root)' : `/${path.join('/')}`)

/** One violation per unrecognised key, so a caller can count them. */
function violationsOf(issue: Issue): readonly SchemaViolation[] {
  const path = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') return issue.keys.map(() => ({ path: pointerOf(path), message: 'must NOT have additional properties' }))
  if (issue.code === 'invalid_type' && issue.message.includes('received undefined')) {
    return [{ path: pointerOf(path.slice(0, -1)), message: `must have required property '${path[path.length - 1] ?? ''}'` }]
  }
  return [{ path: pointerOf(path), message: issue.message }]
}

/** Reports every violation, so a config with three mistakes reports all three. */
export function validateConfig(value: unknown): { readonly violations: readonly SchemaViolation[] } {
  const parsed = configSchema.safeParse(value)
  return { violations: parsed.success ? [] : parsed.error.issues.flatMap(violationsOf) }
}
