// The one hook behind the Connections tab and the footer popover: four queries folded through the pure model.
import { useIpcQuery } from '@/renderer/data/query'
import { connectionOverview } from '@/renderer/settings/connections-model'
import type { BoardSnapshot } from '@/types/board'
import type { ConnectionLine } from '@/types/settings'

interface ConnectionOverviewView {
  readonly lines: readonly ConnectionLine[]
  readonly snapshot: BoardSnapshot | undefined
  readonly preflight: ReturnType<typeof useIpcQuery<'runtime:preflight'>>
  readonly gh: ReturnType<typeof useIpcQuery<'gh:status'>>
}

export function useConnectionOverview(): ConnectionOverviewView {
  const preflight = useIpcQuery('runtime:preflight')
  const gh = useIpcQuery('gh:status')
  const board = useIpcQuery('board:snapshot')
  const repos = useIpcQuery('repos:list')
  const displayNames: Record<string, string> = {}
  if (repos.data?.ok === true) {
    for (const entry of repos.data.repositories) displayNames[entry.id] = 'config' in entry ? entry.config.repo : entry.displayName
  }
  const lines = connectionOverview({ preflight, gh, snapshot: board.data, displayNames, now: new Date() })
  return { lines, snapshot: board.data, preflight, gh }
}
