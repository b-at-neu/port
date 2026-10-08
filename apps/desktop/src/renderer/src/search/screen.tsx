// The Search screen — a repository-scoped or all-repositories full-text search over local transcripts.
import { useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronLeft, Search as SearchIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useIpcQuery } from '../data/query'
import { ROUTE_IDS } from '../router/routes'
import { relativeTime } from '../lib/relative-time'
import type { SearchResult, SearchScope } from '../../../shared/search/types'
import { MIN_TERM_CHARS } from '../../../shared/search/types'
import { emptyCopy, errorCopy, footnotes, groupHeader, IDLE_NOTICE, kindChip, SEARCH_HINT, SEARCHING_COPY, summaryLine, TOO_SHORT_COPY } from './copy'

export function SearchScreen() {
  const search = useSearch({ from: ROUTE_IDS.search })
  const navigate = useNavigate()
  const [scope, setScope] = useState<SearchScope>(search.repo !== null && search.repo !== undefined ? { kind: 'repo', repoId: search.repo } : { kind: 'all' })
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState<{ readonly query: string; readonly scope: SearchScope } | null>(null)

  const result = useIpcQuery('search:query', submitted !== null ? { query: submitted.query, scope: submitted.scope } : undefined)

  function submit(): void {
    const trimmed = query.trim()
    if (trimmed.length < MIN_TERM_CHARS) {
      setSubmitted(null)
      return
    }
    setSubmitted({ query: trimmed, scope })
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-title font-semibold">
        <Button variant="ghost" size="small" onClick={() => void navigate({ to: ROUTE_IDS.history, search: {} })} aria-label="Back">
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>
        <span>Search transcripts</span>
        <Select value={scope.kind} onValueChange={(value) => setScope(value === 'repo' && search.repo ? { kind: 'repo', repoId: search.repo } : { kind: 'all' })}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="repo" disabled={!search.repo}>
              This repository
            </SelectItem>
            <SelectItem value="all">All repositories</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        className="flex gap-2 px-4"
      >
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="An error, a file path, a decision" className="flex-1" />
        <Button type="submit">
          <SearchIcon aria-hidden="true" className="size-3.5" />
          Search
        </Button>
      </form>
      <p className="px-4 text-meta text-muted-foreground">{SEARCH_HINT}</p>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {submitted === null ? (
          query.trim().length > 0 && query.trim().length < MIN_TERM_CHARS ? (
            <p className="text-small text-danger-pill-foreground">{TOO_SHORT_COPY}</p>
          ) : (
            <p className="text-small text-muted-foreground">{IDLE_NOTICE}</p>
          )
        ) : result.status === 'pending' ? (
          <>
            <p className="text-small text-muted-foreground">Searching…</p>
            <p className="text-meta text-muted-foreground">{SEARCHING_COPY}</p>
          </>
        ) : result.status === 'error' ? (
          <p className="text-small text-danger-pill-foreground">Could not reach the main process.</p>
        ) : !result.data.ok ? (
          <p className="text-small text-danger-pill-foreground">{errorCopy(result.data.kind, result.data.kind === 'sessions-unavailable' ? result.data.message : null)}</p>
        ) : (
          <SearchResults data={result.data} />
        )}
      </div>
    </div>
  )
}

function SearchResults({ data }: { readonly data: Extract<SearchResult, { readonly ok: true }> }) {
  const navigate = useNavigate()

  if (data.groups.length === 0) {
    return <p className="text-small text-muted-foreground">{emptyCopy(data)}</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-muted-foreground">{summaryLine(data)}</p>
      {data.groups.map((group) => (
        <div key={`${group.sessionId}:${group.agentId ?? ''}`} className="flex flex-col gap-1">
          <div className="text-meta font-medium text-muted-foreground">{groupHeader(group, relativeTime(group.idleMs))}</div>
          <div className="flex flex-col gap-1">
            {group.hits.map((hit, index) => {
              const { text, matchStart, matchLength } = hit.snippet
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() =>
                    void navigate({
                      to: ROUTE_IDS.transcript,
                      params: { sessionId: group.sessionId },
                      search: { agentId: group.agentId, from: 'search', focusIndex: hit.entryIndex, title: group.label },
                    })
                  }
                  className="flex flex-col items-start gap-0.5 rounded-md px-2 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-2 text-meta text-muted-foreground">
                    <span>{kindChip(hit)}</span>
                    <span>{new Date(hit.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-small">
                    {text.slice(0, matchStart)}
                    <mark>{text.slice(matchStart, matchStart + matchLength)}</mark>
                    {text.slice(matchStart + matchLength)}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {footnotes(data).map((note) => (
        <p key={note} className="text-meta text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  )
}
