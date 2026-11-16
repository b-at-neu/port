// The header's Repositories dropdown — one checkbox per ready repository, and the menu stays open while toggling.
import { FolderGit2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { BACKLOG_REPO_FILTER_SHOW_ALL, backlogRepoFilterButtonCopy } from '@/renderer/backlog/copy'
import { repoFilterCount } from '@/renderer/backlog/sections'
import type { RepoId } from '@/utils/repos'

interface RepoFilterMenuProps {
  readonly repos: readonly { readonly id: RepoId; readonly repo: string }[]
  readonly hidden: ReadonlySet<RepoId>
  readonly onToggle: (id: RepoId) => void
  readonly onShowAll: () => void
}

export function RepoFilterMenu({ repos, hidden, onToggle, onShowAll }: RepoFilterMenuProps) {
  const { shown, total } = repoFilterCount(repos, hidden)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="small" data-slot="backlog-repo-filter">
          <FolderGit2 aria-hidden="true" className="size-3.5" />
          {backlogRepoFilterButtonCopy(shown, total)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {repos.map((repo) => (
          <DropdownMenuCheckboxItem
            key={repo.id}
            checked={!hidden.has(repo.id)}
            onSelect={(event) => {
              event.preventDefault()
              onToggle(repo.id)
            }}
          >
            {repo.repo}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={shown === total} onSelect={onShowAll}>
          {BACKLOG_REPO_FILTER_SHOW_ALL}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
