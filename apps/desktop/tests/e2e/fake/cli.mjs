#!/usr/bin/env node
// The E2E harness's fake gh/git/node/claude. Plain Node, no deps.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [, , command, ...args] = process.argv
const statePath = process.env.PORT_E2E_STATE
const callsPath = process.env.PORT_E2E_CALLS

function loadState() {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function recordCall() {
  if (callsPath === undefined) return
  appendFileSync(callsPath, `${JSON.stringify({ command, args, cwd: process.cwd() })}\n`)
}

function unscripted() {
  process.stderr.write(`fake: unscripted ${command} ${args.join(' ')}\n`)
  process.exit(1)
}

recordCall()

if (statePath === undefined) {
  process.stderr.write('fake: PORT_E2E_STATE is not set\n')
  process.exit(1)
}

// --- git ---------------------------------------------------------------

// `git()` (platform/git.ts) always prepends `-c core.quotepath=false` — skip every leading
// `-c <value>` pair before reading the real subcommand.
function gitArgsAfterGlobalFlags() {
  let i = 0
  while (args[i] === '-c') i += 2
  return args.slice(i)
}

function handleGit() {
  const state = loadState()
  const gitArgs = gitArgsAfterGlobalFlags()
  const sub = gitArgs[0]

  if (sub === 'rev-parse') {
    if (gitArgs.includes('--show-toplevel')) {
      process.stdout.write(`${process.cwd()}\n`)
      return process.exit(0)
    }
    if (gitArgs.includes('--abbrev-ref')) {
      process.stdout.write(`${state.gitBranch ?? 'dev'}\n`)
      return process.exit(0)
    }
    if (gitArgs.includes('--short')) {
      process.stdout.write(`${state.gitSha ?? 'abc1234'}\n`)
      return process.exit(0)
    }
    if (gitArgs.includes('--git-common-dir')) {
      process.stdout.write('.git\n')
      return process.exit(0)
    }
    return unscripted()
  }
  if (sub === 'status') {
    process.stdout.write('')
    return process.exit(0)
  }
  if (sub === 'worktree' && gitArgs[1] === 'list') {
    process.stdout.write(`worktree ${process.cwd()}\nbranch refs/heads/${state.gitBranch ?? 'dev'}\n\n`)
    return process.exit(0)
  }
  if (sub === 'remote' && gitArgs[1] === 'get-url') {
    process.stdout.write(`https://github.com/${state.repo}.git\n`)
    return process.exit(0)
  }
  return unscripted()
}

// --- gh: label/comment writes -------------------------------------------

function flagValues(flag) {
  const values = []
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) values.push(args[i + 1])
  }
  return values
}

function findItem(state, number) {
  const issue = state.issues.find((i) => i.number === number)
  if (issue) return { kind: 'issue', item: issue }
  const pull = state.pulls.find((p) => p.number === number)
  if (pull) return { kind: 'pull-request', item: pull }
  return null
}

function handleEdit(kind) {
  const number = Number(args[2])
  const state = loadState()
  const found = findItem(state, number)
  if (!found) {
    process.stderr.write(`fake: ${kind} #${String(number)} not found in scripted state\n`)
    return process.exit(1)
  }
  const addLabels = flagValues('--add-label')
  const removeLabels = flagValues('--remove-label')
  const labels = new Set(found.item.labels)
  for (const label of addLabels) labels.add(label)
  for (const label of removeLabels) labels.delete(label)
  found.item.labels = [...labels]
  const assignees = new Set(found.item.assignees ?? [])
  for (const login of flagValues('--add-assignee')) assignees.add(login)
  for (const login of flagValues('--remove-assignee')) assignees.delete(login)
  found.item.assignees = [...assignees]
  saveState(state)
  process.stdout.write('')
  return process.exit(0)
}

function handleComment(kind) {
  const number = Number(args[2])
  const state = loadState()
  const found = findItem(state, number)
  if (!found) {
    process.stderr.write(`fake: ${kind} #${String(number)} not found in scripted state\n`)
    return process.exit(1)
  }
  const bodyFileIdx = args.indexOf('--body-file')
  if (bodyFileIdx === -1) return unscripted()
  const body = readFileSync(args[bodyFileIdx + 1], 'utf8')
  found.item.comments = [...(found.item.comments ?? []), body]
  saveState(state)
  process.stdout.write('')
  return process.exit(0)
}

// --- gh: GraphQL ----------------------------------------------------------

function graphqlArg() {
  for (const arg of args) {
    if (arg.startsWith('query=')) return arg.slice('query='.length)
  }
  return null
}

function nodeOf(kind, item) {
  return {
    __typename: kind === 'issue' ? 'Issue' : 'PullRequest',
    number: item.number,
    title: item.title,
    url: item.url ?? `https://github.com/x/x/${kind === 'issue' ? 'issues' : 'pull'}/${String(item.number)}`,
    body: item.body ?? '',
    state: item.state ?? 'OPEN',
    closedAt: item.closedAt ?? null,
    mergedAt: kind === 'pull-request' ? (item.mergedAt ?? null) : undefined,
    updatedAt: item.updatedAt ?? '2024-01-01T00:00:00Z',
    headRefOid: item.headRefOid ?? 'deadbeef',
    mergeable: item.mergeable ?? 'MERGEABLE',
    assignees: { nodes: (item.assignees ?? []).map((login) => ({ login })) },
    labels: { nodes: (item.labels ?? []).map((name) => ({ name })) },
    blockedBy: { totalCount: (item.blockedBy ?? []).length, nodes: item.blockedBy ?? [] },
    reviews: { totalCount: 0, nodes: [] },
    comments: { totalCount: (item.comments ?? []).length, nodes: (item.comments ?? []).map((body) => ({ body, createdAt: new Date().toISOString() })) },
    timelineItems: { nodes: item.labelEvents ?? [] },
  }
}

// Every alias pattern the app's query builders emit (query.ts) — matched generically so one
// interpreter serves the pipeline, items-by-number, item-states and claim/gate-preflight queries.
function matchAll(regex, document) {
  const matches = []
  let match
  const re = new RegExp(regex, 'g')
  while ((match = re.exec(document)) !== null) matches.push(match)
  return matches
}

function handleGraphQL() {
  const document = graphqlArg()
  if (document === null) return unscripted()
  const state = loadState()
  const repository = {}

  // The pipeline sweep's one multi-label connection per surface: `labels:` matches any listed name,
  // and every match comes back on a single, final page.
  const sweepPattern = (surface) => `(\\w+):\\s*${surface}\\(states:\\s*OPEN,\\s*first:\\s*\\d+,\\s*labels:\\s*\\[((?:"(?:[^"\\\\]|\\\\.)*"(?:,\\s*)?)*)\\]`
  const lastPage = { hasNextPage: false, endCursor: null }
  for (const match of matchAll(sweepPattern('issues'), document)) {
    const [, alias, list] = match
    const labels = JSON.parse(`[${list}]`)
    const nodes = state.issues.filter((i) => (i.labels ?? []).some((name) => labels.includes(name)) && (i.state ?? 'OPEN') === 'OPEN').map((i) => nodeOf('issue', i))
    repository[alias] = { totalCount: nodes.length, pageInfo: lastPage, nodes }
  }
  for (const match of matchAll(sweepPattern('pullRequests'), document)) {
    const [, alias, list] = match
    const labels = JSON.parse(`[${list}]`)
    const nodes = state.pulls.filter((p) => (p.labels ?? []).some((name) => labels.includes(name)) && (p.state ?? 'OPEN') === 'OPEN').map((p) => nodeOf('pull-request', p))
    repository[alias] = { totalCount: nodes.length, pageInfo: lastPage, nodes }
  }
  for (const match of matchAll('(\\w+):\\s*issueOrPullRequest\\(number:\\s*(\\d+)\\)', document)) {
    const [, alias, numberText] = match
    const found = findItem(state, Number(numberText))
    repository[alias] = found ? nodeOf(found.kind, found.item) : null
  }
  for (const match of matchAll('(\\w+):\\s*issue\\(number:\\s*(\\d+)\\)', document)) {
    const [, alias, numberText] = match
    const issue = state.issues.find((i) => i.number === Number(numberText))
    repository[alias] = issue ? nodeOf('issue', issue) : null
  }
  for (const match of matchAll('(\\w+):\\s*pullRequest\\(number:\\s*(\\d+)\\)', document)) {
    const [, alias, numberText] = match
    const pull = state.pulls.find((p) => p.number === Number(numberText))
    repository[alias] = pull ? nodeOf('pull-request', pull) : null
  }
  // The Backlog's own unaliased, unfiltered `issues(states: OPEN, …, orderBy: …)` (backlog.ts) —
  // every open issue, newest-updated first, with no `labels:` argument to key off at all.
  if (document.includes('orderBy: {field: UPDATED_AT')) {
    const nodes = state.issues.filter((i) => (i.state ?? 'OPEN') === 'OPEN').map((i) => nodeOf('issue', i))
    repository.issues = { totalCount: nodes.length, nodes }
  }

  if (document.includes('repoLabels:')) {
    const names = new Set()
    for (const issue of state.issues) for (const name of issue.labels ?? []) names.add(name)
    for (const pull of state.pulls) for (const name of pull.labels ?? []) names.add(name)
    for (const name of state.extraLabels ?? []) names.add(name)
    const nodes = [...names].map((name) => ({ name }))
    repository.repoLabels = { totalCount: nodes.length, nodes }
  }

  const data = { repository }
  if (document.includes('rateLimit {')) data.rateLimit = { cost: 1, remaining: 4999, resetAt: new Date(Date.now() + 3600_000).toISOString(), limit: 5000 }
  if (document.includes('viewer {')) data.viewer = { login: state.viewer }

  process.stdout.write(JSON.stringify({ data }))
  return process.exit(0)
}

// --- dispatch ---------------------------------------------------------------

function handleGh() {
  const sub = args[0]
  if (sub === 'auth' && args[1] === 'status') {
    process.stdout.write('')
    return process.exit(0)
  }
  if (sub === 'repo' && args[1] === 'view') {
    const state = loadState()
    process.stdout.write(JSON.stringify({ nameWithOwner: state.repo }))
    return process.exit(0)
  }
  if (sub === 'api' && args[1] === 'user') {
    const state = loadState()
    process.stdout.write(JSON.stringify({ login: state.viewer }))
    return process.exit(0)
  }
  if (sub === 'api' && args[1] === 'graphql') return handleGraphQL()
  if ((sub === 'issue' || sub === 'pr') && args[1] === 'edit') return handleEdit(sub)
  if ((sub === 'issue' || sub === 'pr') && args[1] === 'comment') return handleComment(sub)
  return unscripted()
}

switch (command) {
  case 'git':
    handleGit()
    break
  case 'gh':
    handleGh()
    break
  case 'claude':
  case 'node':
    process.stderr.write(`fake: ${command} is never expected to run in an E2E flow\n`)
    process.exit(1)
    break
  default:
    unscripted()
}
