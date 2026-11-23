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

/** One restriction: where it applies (`files` minus `except`, repo-relative to apps/desktop) and what it bans. */
export const RESTRICTIONS = [
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
    except: ['src/main/writes/**', 'src/main/platform/**'],
    paths: [{ name: '@/main/platform/gh', importNames: ['gh', 'ghJson'], message: 'Only main/writes/ calls gh; reads go through platform/github-http.' }],
  },
  {
    id: 'github-http',
    except: ['src/main/github/**'],
    paths: [{ name: '@/main/platform/github-http', importNames: ['githubHttp', 'githubConditional', 'githubPublic'], message: 'Only main/github/ reads GitHub over HTTP.' }],
  },
  {
    id: 'run-command',
    except: ['src/main/platform/**'],
    paths: [{ name: '@/main/platform/run', importNames: ['runCommand'], message: 'Only main/platform/ runs a command — every other adapter goes through gh or git.' }],
  },
  {
    id: 'apply-labels',
    except: ['src/main/pipeline-state/default.ts', 'src/main/writes/**'],
    paths: [{ name: '@/main/writes/apply', importNames: ['applyLabels'], message: 'Only the pipeline-state composition applies labels, so no transition bypasses the store.' }],
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
    except: ['src/main/state/watcher.ts'],
    globals: TIMERS.map((name) => ({ name, message: 'Main holds exactly one clock — only main/state/watcher.ts names a timer.' })),
  },
  { id: 'renderer', files: ['src/renderer/**'], paths: RENDERER_PATHS, syntax: RENDERER_SYNTAX },
  // `types/ipc.ts` is the one place the renderer's types reach `main/`: a type-only read of the router's inferred action map.
  { id: 'pure', files: ['src/renderer/**', 'src/utils/**', 'src/types/**'], except: ['src/types/ipc.ts'], patterns: [NO_MAIN, NODE_BUILTIN] },
  {
    id: 'tick',
    files: ['src/main/tick/**'],
    patterns: [{ group: ['@/main/platform/**'], message: 'main/tick/ decides over an already-built state, it never reaches I/O.' }, NODE_BUILTIN],
  },
  {
    id: 'state',
    files: ['src/main/state/**'],
    paths: ['@/main/platform/gh', '@/main/platform/run'].map((name) => ({ name, message: 'main/state/ composes already-fetched results, it never spawns a command.' })),
  },
  {
    id: 'local',
    files: ['src/main/repos/local/**'],
    paths: [{ name: '@/main/platform/gh', message: 'main/repos/local/ is local-only, never a second GitHub caller.' }],
    patterns: [{ group: ['@/main/github/**'], message: 'main/repos/local/ is local-only, never a second GitHub caller.' }],
  },
  {
    id: 'search',
    files: ['src/main/search/**'],
    patterns: [{ group: ['@/main/sessions/*', '!@/main/sessions/locate', '!@/main/sessions/transcript'], message: 'main/search/ imports only sessions/locate and sessions/transcript.' }],
  },
  {
    id: 'mirror',
    files: ['src/main/pipeline-state/mirror.ts'],
    patterns: [{ group: ['@/main/platform/**', '@/main/writes/**', '@/main/github/**'], message: 'The label mapping stays pure, with no I/O.' }],
  },
  {
    id: 'hosting-permissions',
    files: ['src/main/hosting/**', 'src/utils/hosting/**', 'src/types/hosting.ts'],
    syntax: [
      { selector: "Literal[value='bypassPermissions']", message: "Never bypass the operator's own permission prompt." },
      { selector: "Literal[value='dontAsk']", message: "Never bypass the operator's own permission prompt." },
      { selector: ':matches(Property, TSPropertySignature)[key.name=/^(?:allowDangerouslySkipPermissions|permissionPromptToolName)$/]', message: 'Never skip permissions, and permissionPromptToolName is exclusive with canUseTool.' },
    ],
  },
  {
    id: 'hosting-options',
    files: ['src/main/hosting/**'],
    syntax: [
      { selector: "Property[key.name='tools'][shorthand=false]", message: "A tools: key restricts the whole session's built-in set — use allowedTools." },
      { selector: "Property[key.name='skills'][shorthand=false]", message: 'Commands run as typed slash commands, never through the Skill-tool filter.' },
      { selector: "Property[key.name='prompt'][value.type='Literal'][value.raw=/^[\"']/]", message: 'A string prompt disables Stop — keep streaming input mode.' },
      { selector: "Property[key.name='prompt'][value.type='TemplateLiteral']", message: 'A string prompt disables Stop — keep streaming input mode.' },
      { selector: "CallExpression[callee.property.name='kill']", message: 'The SDK owns termination — never kill a process directly.' },
    ],
  },
  {
    id: 'writes',
    files: ['src/main/writes/**'],
    syntax: [{ selector: 'Literal[value=/^(?:merge|close|--delete-branch|ready)$/]', message: 'Merging and closing stay human actions.' }],
  },
  {
    id: 'stage',
    files: ['src/main/stage/**'],
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
        regex: '^(?!(?:electron|node:path|\\./[\\w-]+|@/types/.+|@/utils/.+|@/main/repos/config/schema|@/main/state/reconcile|@/main/tick/ledger|@/main/tick/plan)$)',
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
