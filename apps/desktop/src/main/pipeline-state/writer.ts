// The one writer every pipeline transition goes through: the store precondition, the store commit, then the label mirror.
import { stateLabelsOf } from '@/main/pipeline-state/labels'
import type { PipelineStateStore } from '@/main/pipeline-state/store'
import { buildCommand, resolveKeys } from '@/main/writes/command'
import { evaluate } from '@/main/writes/scope'
import type { OwnershipRead, ReadOwnershipParams } from '@/types/dispatch'
import type { FetchItemsByNumberParams, GitHubRepoRef, ItemsByNumberFetch } from '@/types/github'
import type { ApplyLabelsParams, AuditEntry, LabelAuditEntry, ObservedItem, WriteOutcome } from '@/types/writes'

interface StateWriterDeps {
  readonly store: PipelineStateStore
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly readOwnership: (params: ReadOwnershipParams) => Promise<OwnershipRead>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly appendAudit: (auditDir: string, entry: AuditEntry) => Promise<unknown>
  readonly now: () => Date
}

function splitRepo(repo: string): GitHubRepoRef {
  const slash = repo.indexOf('/')
  return slash === -1 ? { owner: repo, name: '' } : { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }
}

/** Fails toward the label path: a repository the store does not hold, a terminal owner and an unresolvable key all go to `applyLabels`, which refuses or writes exactly as before. */
export function createStateWriter(deps: StateWriterDeps): (params: ApplyLabelsParams) => Promise<WriteOutcome> {
  return async function writeState(params) {
    const { request, auditDir } = params
    const view = deps.store.view(request.repoId)
    if (view.kind === 'labels') return deps.applyLabels(params)

    const command = buildCommand(request)
    const present = resolveKeys(request.vocabulary, request.expect.present)
    const absent = resolveKeys(request.vocabulary, request.expect.absent)
    if (!command.ok || present.unresolved.length > 0 || absent.unresolved.length > 0) return deps.applyLabels(params)

    const ownership = await deps.readOwnership({ repoRoot: params.repoRoot, repo: request.repo, git: params.git, pathOps: params.pathOps, now: deps.now })
    if (ownership.kind === 'terminal' || ownership.kind === 'unreadable') return deps.applyLabels(params)

    const audit = async (observed: ObservedItem | null, outcome: WriteOutcome): Promise<WriteOutcome> => {
      const entry: LabelAuditEntry = {
        at: deps.now().toISOString(),
        repo: request.repo,
        repoId: request.repoId,
        kind: request.kind,
        number: request.number,
        action: request.action,
        ownership: ownership.kind,
        precondition: { present: present.names, absent: absent.names, assignees: request.expect.assignees },
        observed,
        call: null,
        commentBytes: null,
        result: outcome,
      }
      await deps.appendAudit(auditDir, entry)
      return outcome
    }

    const read = await (params.fetchItemsByNumber ?? deps.fetchItemsByNumber)({ repo: splitRepo(request.repo), numbers: [request.number] })
    if (!read.ok) return audit(null, { kind: 'verify-failed', message: read.message })
    const item = read.resolved.find((candidate) => candidate.number === request.number)
    if (item === undefined || read.unavailable.includes(request.number)) return audit(null, { kind: 'item-unavailable' })

    const githubSide: ObservedItem = { labels: item.labels, assignees: item.assignees, readAt: read.fetchedAt }
    const assignees = evaluate({ presentNames: [], absentNames: [], assignees: request.expect.assignees }, githubSide)
    if (!assignees.satisfied) {
      return audit(githubSide, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: assignees.expected, observed: assignees.observed, readAt: read.fetchedAt } })
    }

    const stored = await deps.store.transition(request.repoId, { kind: request.kind, number: request.number }, {
      add: request.add,
      remove: request.remove,
      expect: { present: request.expect.present, absent: request.expect.absent },
      action: request.action,
      at: deps.now().toISOString(),
      actor: null,
    })
    if (!stored.ok) {
      if (stored.reason === 'persist-failed') return audit(githubSide, { kind: 'state-unsaved', message: stored.message })
      const names = stateLabelsOf(deps.store.view(request.repoId), request.kind, request.number, request.vocabulary) ?? []
      const observed: ObservedItem = { labels: names, assignees: item.assignees, readAt: read.fetchedAt }
      const verdict = evaluate({ presentNames: present.names, absentNames: absent.names, assignees: { kind: 'any' } }, observed)
      const expected = verdict.satisfied ? [] : verdict.expected
      return audit(observed, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected, observed: names, readAt: read.fetchedAt } })
    }

    const mirror = await deps.applyLabels({ ...params, request: { ...request, expect: { present: [], absent: [], assignees: { kind: 'any' } } } })
    return mirror.kind === 'applied' || mirror.kind === 'no-op' ? mirror : { kind: 'mirror-failed', mirror }
  }
}
