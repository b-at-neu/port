// The repo page's Overview tab (#319, plan's own **UX states**).
import { ErrorBanner } from '../components/error-banner'
import type { RepositoryEntry } from '../../../shared/repos'
import { diagnosticCopy, moduleSummary, overrideLineCopy, problemCopy, summaryParts } from './copy'

export function OverviewTab({ entry }: { readonly entry: RepositoryEntry }) {
  if (!('config' in entry)) {
    return <ErrorBanner message={problemCopy(entry.problem)} className="m-4" />
  }

  const { config } = entry
  const branches = summaryParts(config)[0] ?? ''
  const modules = moduleSummary(config.modules)

  return (
    <div className="flex flex-col gap-4 p-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
        <dt className="text-muted-foreground">Branches</dt>
        <dd className="text-foreground">{branches}</dd>
        <dt className="text-muted-foreground">Pipeline labels</dt>
        <dd className="text-foreground">{config.vocabulary.labels.length}</dd>
        <dt className="text-muted-foreground">Modules</dt>
        <dd className="text-foreground">{modules === '' ? 'none' : modules}</dd>
        <dt className="text-muted-foreground">Path</dt>
        <dd className="font-mono text-foreground">{entry.path}</dd>
      </dl>

      {config.overrides.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-small font-medium text-foreground">Overrides in effect</h3>
          {config.overrides.map((override) => (
            <p key={override.path ?? override.reason} className="font-mono text-meta text-muted-foreground">
              {overrideLineCopy(override)}
            </p>
          ))}
        </div>
      ) : null}

      {entry.diagnostics.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-small font-medium text-foreground">Warnings</h3>
          {entry.diagnostics.map((diagnostic, index) => (
            <p key={index} className="text-small text-attention-dot">
              {diagnosticCopy(diagnostic)}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
