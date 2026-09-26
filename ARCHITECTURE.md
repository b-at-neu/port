# Repository map

**A file under `plugins/port/` is read by a stranger's install; a file outside it is not.** That is the one organizing principle behind every placement below. Its corollary: a shipped file may reference only other shipped paths — a reference from `plugins/port/**` to a repository-only doc dangles in every adopter's plugin cache, because that doc never leaves this checkout.

**`Ships`** is binary, never hedged: **yes** means the path is present in an adopter's `${CLAUDE_PLUGIN_ROOT}` and reachable from a shipped file; **no** means it exists only in this checkout. Every row below is the literal `yes` or `no` — there is no third value, because the whole point of the column is that the boundary admits none.

## Map

| Path | Holds | Read by | Ships |
| --- | --- | --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace index naming `./plugins/port` | The plugin client, at install time | no |
| `plugins/port/.claude-plugin/plugin.json` | The plugin manifest; `version` is both the release signal and the on-disk cache key | `/port:init`, the release tooling | yes |
| `plugins/port/agents/` | The plan, impl, review, revise stage prompts | Dispatched subagents | yes |
| `plugins/port/skills/` | The seven `/port:*` skills | The operator's own session | yes |
| `plugins/port/hooks/` | The guard hook and its classifier | Every dispatched `Bash`/`Edit`/`Write` call | yes |
| `plugins/port/templates/` | Fill-in templates only, written into a managed repository by `/port:init` (permissions, config, workflows) and by `/port:analyze` (the standards documents, the scaffolder/auditor skill archetypes) | `/port:init`, `/port:analyze` | yes |
| `plugins/port/bin/` | The three scripts `/port:init` copies verbatim into a managed repository (`artifacts.mjs`, `worktrees.mjs`, `budget.mjs`); `artifacts.mjs` and `worktrees.mjs` also run in place here, addressed through `commands.artifacts`/`commands.worktrees` | `/port:init`, this repository's CI and cockpit | yes |
| `plugins/port/data/` | `labels.json`, the canonical label vocabulary — nothing fills it in | `/port:init`, this repository's layer 1 checks, the desktop app's label vocabulary | yes |
| `plugins/port/docs/` | `PIPELINE.md`, `FORMATS.md`, `RECOVERY.md` — the operator's reference | Every stage agent, resolved as `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md` (and its two companions) | yes |
| `schema/` | `port.config.schema.json`, the per-repo config contract | An adopter's editor, via the `$schema` key it inherits | no |
| `scripts/` | TypeScript, type-stripped at load with zero runtime dependencies. The layer 1 static checks, the committed file-size limit and ratchet they enforce, the per-check `guard(#N)` marker index (`--guards`), the tick engine (`port-tick.ts`, `port-tick/`) that computes the cockpit's decisions when `commands.tick` is set — including the trajectory record it emits to `.agents/events.jsonl` (`port-tick/events.ts`) and the `report` subcommand that reads it back (`port-tick/report.ts`) — the forensics engine (`port-forensics.mjs`, `port-forensics/`, `lib/transcript.mjs`) that asserts on dispatched-agent transcripts when `commands.forensics` is set, and `dev-window.ts`, the dev-window restorer that keeps `dev`'s version prerelease-suffixed | Contributors, CI, the cockpit (via `commands.tick`/`commands.forensics`), `/port:release` (via `release.postPublishHook`) | no |
| `evals/` | Layer 3 behavioural eval cases and graders | Contributors, CI (gated) | no |
| `docs/` | Contributor-facing reference (`TESTING.md`, `USAGE.md`, `COORDINATION.md`) | Contributors | no |
| `.github/workflows/` | CI workflow definitions | GitHub Actions | no |
| `apps/desktop/` | The Electron + TypeScript desktop app | Contributors building the UI track | no |
| `.claude/` | This repository's own settings and port config, self-hosting the pipeline it ships | The cockpit and dispatched agents, in this checkout only | no |

## Placements that cannot move

Each of these reads as arbitrary and is not — the reason is recoverable only by reading code, or by having been present when it was decided.

### `schema/` at the repository root

Its `$id` (`schema/port.config.schema.json:3`) and the `$schema` key every adopter's config inherits (`plugins/port/templates/port.config.json:2`) are absolute `raw.githubusercontent.com/…/main/schema/…` URLs. Moving `schema/` breaks editor validation in every repository that has already run `/port:init`, silently and retroactively — nothing re-fetches the old URL to notice it 404s.

### `plugins/port/docs/PIPELINE.md`, `FORMATS.md`, `RECOVERY.md`

Every agent and skill resolves the hub as `${CLAUDE_PLUGIN_ROOT}/docs/PIPELINE.md`; its two companions resolve the same `${CLAUDE_PLUGIN_ROOT}/docs/` argument with their own filename. At the repository root all three are unreachable from an install — `${CLAUDE_PLUGIN_ROOT}` only ever points inside the plugin directory.

### `plugins/<name>/` nesting, and `.claude-plugin/marketplace.json` at the root

Both are mandated by the marketplace format, not chosen. `marketplace.json`'s `source` is `./plugins/port`; a marketplace index and its plugin directories have to sit where the format expects them, or the client's own resolution fails.

### The five root toolchain files

`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.prettierrc.json` serve `apps/desktop` alone. They are not an optimization: the Agent SDK pulls a ~327 MB per-platform binary, so a shared, content-addressable pnpm store is what stops a fresh agent worktree re-downloading it on every checkout (`CONTRIBUTING.md` → "Working on the desktop app"). A two-commit scaffold with five toolchain files at the root looks like noise; it is the workspace those two files exist to make free.

## What the tree is not

This repository is ~95% markdown prompts and zero-dependency Node scripts. The pnpm workspace, the `tsconfig`, and Prettier at the root are TypeScript signals that belong entirely to `apps/desktop`, the separate UI track — nothing else in the tree depends on them.

## Adding a file

- **Read by an adopter's install** → under `plugins/port/`, and it may reference only other shipped paths.
- **This repository's own tooling** → `scripts/`, `evals/`, or `docs/`.
