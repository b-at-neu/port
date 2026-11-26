// Import, global and syntax boundaries as import-free data; flat config replaces options per rule, so each file gets one block with all its restrictions.

const SRC = ['src/**']
const TESTING = 'Tests and fixtures are never imported from src/.'
const FS_SYNC_NAMES = [
  'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmdirSync', 'rmSync', 'unlinkSync', 'existsSync', 'statSync', 'lstatSync',
  'readdirSync', 'renameSync', 'copyFileSync', 'accessSync', 'realpathSync', 'chmodSync', 'symlinkSync', 'readlinkSync',
]
const SDK_SEAMS = ['src/main/platform/sdk.ts']
const TIMERS = ['setTimeout', 'setInterval', 'setImmediate']
const NODE_BUILTIN = { group: ['node:*'], message: 'A node: builtin is not available here — this code compiles without Node types.' }
const NO_MAIN = { group: ['@/main/**'], message: 'The renderer and shared code never import main/ — reach it over IPC.' }

const syncSelector = (names) => `CallExpression[callee.name=/^(?:${names.join('|')})$/], CallExpression[callee.property.name=/^(?:${names.join('|')})$/]`

export const RENDERER_PATHS = [
  {
    name: 'react',
    importNames: ['useEffect', 'useLayoutEffect'],
    message: 'useEffect/useLayoutEffect are banned here — use TanStack Query, useSyncExternalStore, or a ref callback instead.',
  },
]

export const RENDERER_SYNTAX = [
  { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'innerHTML is banned here — a tool result or repository text is untrusted.' },
  { selector: "AssignmentExpression[left.property.name='outerHTML']", message: 'outerHTML is banned here — a tool result or repository text is untrusted.' },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'insertAdjacentHTML is banned here — a tool result or repository text is untrusted.' },
]

/** Each `src/main/<dir>` and the `src/main/<dir>` layers it may import. `app/` and `src/main/index.ts` are the composition roots and have no row. */
export const LAYERS = {
  platform: ['platform'],
  repos: ['platform', 'repos'],
  github: ['platform', 'repos', 'github'],
  sessions: ['platform', 'repos', 'sessions'],
  pipeline: ['platform', 'repos', 'github', 'sessions', 'pipeline'],
  dispatch: ['platform', 'repos', 'github', 'sessions', 'pipeline', 'dispatch'],
  worker: ['platform', 'repos', 'github', 'sessions', 'pipeline', 'worker'],
  // `app` is listed so the carve-out below can name the three modules features may take from it.
  features: ['platform', 'repos', 'github', 'sessions', 'pipeline', 'dispatch', 'features', 'app'],
}

const MAIN_DIRS = [...Object.keys(LAYERS), 'app']
const LAYER_MESSAGE = `Layer order is platform, repos, then github and sessions, then pipeline, then dispatch or worker, then features; only app/ composes all of them (ENGINEERING §9).`
const FEATURES_PATTERNS = [
  { regex: '^@/main/app(?:/(?!(?:define|schemas|context)$).*)?$', message: 'features/ imports from app/ only define, schemas and context.' },
  { regex: '^@/main/platform/(?!(?:paths|json-store)$)', message: 'features/ reaches platform through ctx; only platform/paths and platform/json-store are importable.' },
]

const layerRestriction = (dir) => ({
  id: `layer-${dir}`,
  files: [`src/main/${dir}/**`],
  patterns: [
    {
      regex: `^@/main/(?:${MAIN_DIRS.filter((other) => !LAYERS[dir].includes(other)).join('|')})(?:/.*)?$`,
      message: `main/${dir}/ may import only ${LAYERS[dir].join(', ')}. ${LAYER_MESSAGE}`,
    },
    ...(dir === 'features' ? FEATURES_PATTERNS : []),
  ],
  ...(dir === 'features' ? { paths: [{ name: 'electron', message: 'Only main/app/ and main/platform/ reach Electron.' }] } : {}),
})

const GH_WRITE_NAME = '^ghWrite$'
const GITHUB_HTTP_NAME = '^github(?:Http|Conditional|Public)$'

const memberSyntax = (name, message) => [
  { selector: `MemberExpression[property.name=/${name}/]`, message },
  { selector: `ObjectPattern > Property[key.name=/${name}/]`, message },
]

/** One restriction: where it applies (`files` minus `except`, repo-relative to apps/desktop) and what it bans. */
export const RESTRICTIONS = [
  ...Object.keys(LAYERS).map(layerRestriction),
  {
    id: 'gh-write',
    except: ['src/main/github/writes/**', 'src/main/platform/**', 'src/main/worker/engine.ts'],
    syntax: memberSyntax(GH_WRITE_NAME, 'Writes go through `github/writes`; take a narrow ctx instead.'),
  },
  {
    id: 'github-http-member',
    except: ['src/main/github/**', 'src/main/platform/**', 'src/main/worker/engine.ts'],
    syntax: memberSyntax(GITHUB_HTTP_NAME, 'GitHub reads go through the tracker in `github/`; take a narrow ctx instead.'),
  },
  {
    id: 'child-process',
    except: ['src/main/platform/run.ts'],
    paths: ['child_process', 'node:child_process'].map((name) => ({ name, message: 'Only main/platform/run.ts spawns a process.' })),
  },
  {
    id: 'child-process-names',
    files: ['src/main/platform/run.ts'],
    paths: [{ name: 'node:child_process', importNames: ['exec', 'execSync', 'execFileSync', 'spawnSync', 'fork'], message: 'Only async execFile and spawn, never through a shell.' }],
  },
  {
    id: 'fs',
    except: ['src/main/platform/**'],
    paths: ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].map((name) => ({ name, message: 'Only main/platform/ touches the filesystem — reach it through ctx.' })),
  },
  {
    id: 'fs-names',
    files: ['src/main/platform/**'],
    paths: [
      { name: 'node:fs', importNames: [...FS_SYNC_NAMES, 'watch', 'watchFile'], message: 'No synchronous fs call and no watcher — a watch is never the correctness mechanism.' },
      { name: 'fs', importNames: [...FS_SYNC_NAMES, 'watch', 'watchFile'], message: 'No synchronous fs call and no watcher — a watch is never the correctness mechanism.' },
      { name: 'node:fs/promises', importNames: ['watch'], message: 'No watcher — a watch is never the correctness mechanism.' },
    ],
    syntax: [{ selector: syncSelector(FS_SYNC_NAMES), message: 'No synchronous fs call anywhere under src/.' }],
  },
  { id: 'chokidar', paths: [{ name: 'chokidar', message: 'No filesystem watcher — a watch is never the correctness mechanism.' }] },
  {
    id: 'sdk',
    except: SDK_SEAMS,
    paths: [{ name: '@anthropic-ai/claude-agent-sdk', message: 'Only main/platform/sdk.ts references the Agent SDK.' }],
  },
  {
    id: 'sdk-names',
    files: SDK_SEAMS,
    paths: [{ name: '@anthropic-ai/claude-agent-sdk', importNames: ['getSessionMessages', 'getSubagentMessages'], message: 'Read transcripts through main/sessions/, never the SDK.' }],
  },
  { id: 'no-tests', patterns: [{ group: ['**/tests/**'], message: TESTING }] },
  { id: 'no-repo-scripts', patterns: [{ group: ['**/scripts/**', '**/plugins/**'], message: 'apps/desktop/src imports nothing from scripts/ or plugins/ (ENGINEERING §9).' }] },
  {
    id: 'gh',
    except: ['src/main/github/writes/**', 'src/main/platform/**'],
    paths: [{ name: '@/main/platform/gh', importNames: ['gh', 'ghJson'], message: 'Only main/github/writes/ calls gh; reads go through platform/github-http.' }],
  },
  {
    id: 'github-http',
    except: ['src/main/github/**', 'src/main/platform/index.ts', 'src/main/worker/engine.ts', 'src/main/pipeline/board/read.ts', 'src/main/features/worktrees/inspect.ts'],
    paths: [{ name: '@/main/platform/github-http', importNames: ['githubHttp', 'githubConditional', 'githubPublic'], message: 'Only main/github/ reads GitHub over HTTP.' }],
  },
  {
    id: 'run-command',
    except: ['src/main/platform/**'],
    paths: [{ name: '@/main/platform/run', importNames: ['runCommand'], message: 'Only main/platform/ runs a command — every other adapter goes through gh or git.' }],
  },
  {
    id: 'apply-labels',
    except: ['src/main/pipeline/state/writer.ts', 'src/main/github/writes/**'],
    paths: [{ name: '@/main/github/writes/apply', importNames: ['applyLabels'], message: 'Only the state writer applies labels, so no transition bypasses the store.' }],
  },
  {
    id: 'fetch',
    except: ['src/main/platform/github-http.ts'],
    globals: [{ name: 'fetch', message: 'Only main/platform/github-http.ts reaches the network.' }],
  },
  {
    id: 'global-syntax',
    syntax: [
      { selector: "Property[key.name='shell'][value.value=true]", message: 'shell: true is banned — every spawn is shell:false.' },
      { selector: "Literal[value='@me']", message: "The login is resolved and recorded, never the '@me' sentinel." },
    ],
  },
  {
    id: 'one-clock',
    files: ['src/main/**'],
    except: ['src/main/pipeline/board/watcher.ts'],
    globals: TIMERS.map((name) => ({ name, message: 'Main holds exactly one clock — only main/pipeline/board/watcher.ts names a timer.' })),
  },
  { id: 'renderer', files: ['src/renderer/**'], paths: RENDERER_PATHS, syntax: RENDERER_SYNTAX },
  // `types/ipc.ts` is the one place the renderer's types reach `main/`: a type-only read of the router's inferred action map.
  { id: 'pure', files: ['src/renderer/**', 'src/utils/**', 'src/types/**'], except: ['src/types/ipc.ts'], patterns: [NO_MAIN, NODE_BUILTIN] },
  {
    id: 'tick',
    files: ['src/main/pipeline/tick/**'],
    patterns: [{ group: ['@/main/platform/**'], message: 'main/pipeline/tick/ decides over an already-built state, it never reaches I/O.' }, NODE_BUILTIN],
  },
  {
    id: 'state',
    files: ['src/main/pipeline/board/**'],
    paths: ['@/main/platform/gh', '@/main/platform/run'].map((name) => ({ name, message: 'main/pipeline/board/ composes already-fetched results, it never spawns a command.' })),
  },
  {
    id: 'local',
    files: ['src/main/repos/local/**'],
    paths: [{ name: '@/main/platform/gh', message: 'main/repos/local/ is local-only, never a second GitHub caller.' }],
    patterns: [{ group: ['@/main/github/**'], message: 'main/repos/local/ is local-only, never a second GitHub caller.' }],
  },
  {
    id: 'search',
    files: ['src/main/sessions/search/**'],
    patterns: [{ regex: '^@/main/sessions/(?!(?:locate|transcript|search/[\\w-]+)$)', message: 'main/sessions/search/ imports only sessions/locate and sessions/transcript.' }],
  },
  {
    id: 'mirror',
    files: ['src/main/pipeline/state/mirror.ts'],
    patterns: [{ group: ['@/main/platform/**', '@/main/github/**'], message: 'The label mapping stays pure, with no I/O.' }],
  },
  {
    id: 'hosting-permissions',
    files: ['src/main/sessions/hosting/**', 'src/utils/hosting/**', 'src/types/hosting.ts'],
    syntax: [
      { selector: "Literal[value='bypassPermissions']", message: "Never bypass the operator's own permission prompt." },
      { selector: "Literal[value='dontAsk']", message: "Never bypass the operator's own permission prompt." },
      { selector: ':matches(Property, TSPropertySignature)[key.name=/^(?:allowDangerouslySkipPermissions|permissionPromptToolName)$/]', message: 'Never skip permissions, and permissionPromptToolName is exclusive with canUseTool.' },
    ],
  },
  {
    id: 'hosting-options',
    files: ['src/main/sessions/hosting/**'],
    syntax: [
      { selector: "Property[key.name='tools'][shorthand=false]", message: "A tools: key restricts the whole session's built-in set — use allowedTools." },
      { selector: "Property[key.name='skills'][shorthand=false]:not(FunctionDeclaration[id.name='stageOptions'] Property)", message: 'Commands run as typed slash commands, never through the Skill-tool filter; only a stage session, which has none, narrows its skills.' },
      { selector: "Property[key.name='prompt'][value.type='Literal'][value.raw=/^[\"']/]", message: 'A string prompt disables Stop — keep streaming input mode.' },
      { selector: "Property[key.name='prompt'][value.type='TemplateLiteral']", message: 'A string prompt disables Stop — keep streaming input mode.' },
      { selector: "CallExpression[callee.property.name='kill']", message: 'The SDK owns termination — never kill a process directly.' },
    ],
  },
  {
    id: 'writes',
    files: ['src/main/github/writes/**'],
    syntax: [{ selector: 'Literal[value=/^(?:merge|close|--delete-branch|ready)$/]', message: 'Merging and closing stay human actions.' }],
  },
  {
    id: 'stage',
    files: ['src/main/dispatch/stage/**'],
    syntax: [
      { selector: 'Literal[value=/^--force/]', message: 'A stage hand-back never forces a worktree removal.' },
      { selector: ":matches(CallExpression[callee.name='dismiss'], CallExpression[callee.property.name='dismiss']) > Literal[value='force']", message: 'A stage hand-back never forces a worktree removal.' },
    ],
  },
  {
    id: 'fixtures',
    files: ['tests/fixtures/app/**'],
    patterns: [
      {
        regex: '^(?!(?:electron|node:path|\\./[\\w-]+|@/types/.+|@/utils/.+|@/main/repos/config/schema|@/main/pipeline/board/reconcile|@/main/pipeline/tick/ledger|@/main/pipeline/tick/plan)$)',
        message: 'Fixture mode may import only these modules — it must never reach gh or claude.',
      },
    ],
  },
]

/** `glob` (`*`, `**`, `**\/`) as an anchored RegExp over a posix path. */
function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        out += '(?:.*/)?'
      } else out += '.*'
    } else if (c === '*') out += '[^/]*'
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

const matchesAny = (globs, file) => globs.some((g) => globToRegExp(g).test(file))
const applies = (r, file) => matchesAny(r.files ?? SRC, file) && !matchesAny(r.except ?? [], file)

/** The `layer-*` restrictions that flag `file` importing `spec`. */
export function layerViolations(file, spec) {
  return RESTRICTIONS.filter((r) => r.id.startsWith('layer-') && applies(r, file) && (r.patterns ?? []).some((p) => new RegExp(p.regex).test(spec))).map((r) => r.id)
}

const MEMBER_RULES = { 'gh-write': GH_WRITE_NAME, 'github-http-member': GITHUB_HTTP_NAME }

/** Whether the member rule `rule` flags a property named `name`. */
export const memberFlagged = (rule, name) => new RegExp(MEMBER_RULES[rule]).test(name)

export const LAYER_CASES = [
  { file: 'src/main/sessions/x.ts', spec: '@/main/github/y', allowed: false },
  { file: 'src/main/sessions/x.ts', spec: '@/main/pipeline/context', allowed: false },
  { file: 'src/main/sessions/x.ts', spec: '@/main/repos', allowed: true },
  { file: 'src/main/github/x.ts', spec: '@/main/sessions/locate', allowed: false },
  { file: 'src/main/platform/x.ts', spec: '@/main/repos', allowed: false },
  { file: 'src/main/repos/x.ts', spec: '@/main/platform/paths', allowed: true },
  { file: 'src/main/pipeline/x.ts', spec: '@/main/github/tracker', allowed: true },
  { file: 'src/main/pipeline/x.ts', spec: '@/main/dispatch/context', allowed: false },
  { file: 'src/main/dispatch/x.ts', spec: '@/main/pipeline/context', allowed: true },
  { file: 'src/main/dispatch/x.ts', spec: '@/main/worker/client', allowed: false },
  { file: 'src/main/worker/x.ts', spec: '@/main/dispatch/launch', allowed: false },
  { file: 'src/main/worker/x.ts', spec: '@/main/pipeline/context', allowed: true },
  { file: 'src/main/features/x.ts', spec: '@/main/app/router', allowed: false },
  { file: 'src/main/features/x.ts', spec: '@/main/app/context', allowed: true },
  { file: 'src/main/features/x.ts', spec: '@/main/worker/client', allowed: false },
  { file: 'src/main/features/x.ts', spec: '@/main/platform/gh', allowed: false },
  { file: 'src/main/features/x.ts', spec: '@/main/platform/paths', allowed: true },
  { file: 'src/main/features/x.ts', spec: '@/main/platform', allowed: true },
  { file: 'src/main/app/x.ts', spec: '@/main/worker/client', allowed: true },
  { file: 'src/main/index.ts', spec: '@/main/app/router', allowed: true },
]

export const MEMBER_CASES = [
  { name: 'ghWrite', rule: 'gh-write', flagged: true },
  { name: 'gh', rule: 'gh-write', flagged: false },
  { name: 'githubHttp', rule: 'github-http-member', flagged: true },
  { name: 'githubConditional', rule: 'github-http-member', flagged: true },
  { name: 'githubPublic', rule: 'github-http-member', flagged: true },
  { name: 'github', rule: 'github-http-member', flagged: false },
  { name: 'githubTracker', rule: 'github-http-member', flagged: false },
]

/** One config block per distinct set of restrictions, each listing its files by exact path. */
export function boundaryBlocks(files) {
  const groups = new Map()
  for (const file of files) {
    const hits = RESTRICTIONS.filter((r) => applies(r, file))
    if (hits.length === 0) continue
    const key = hits.map((r) => r.id).join(',')
    groups.set(key, { hits, files: [...(groups.get(key)?.files ?? []), file] })
  }
  const rule = (hits, field) => {
    const list = hits.flatMap((r) => r[field] ?? [])
    return list.length === 0 ? 'off' : ['error', ...list]
  }
  return [...groups.values()].map(({ hits, files: group }) => {
    const paths = hits.flatMap((r) => r.paths ?? [])
    const patterns = hits.flatMap((r) => r.patterns ?? [])
    return {
      files: group,
      rules: {
        'no-restricted-imports': paths.length + patterns.length === 0 ? 'off' : ['error', { paths, patterns }],
        'no-restricted-syntax': rule(hits, 'syntax'),
        'no-restricted-globals': rule(hits, 'globals'),
      },
    }
  })
}
