// Work on's confirmation for a blocked ticket — lists its open blockers.
import type { ConfirmSpec } from '@/renderer/components/confirm-dialog'
import { BACKLOG_START_ANYWAY, backlogBlockedReasonCopy, backlogBlockerLine, backlogBlockerTruncatedCopy, backlogStartAnywayTitle } from '@/renderer/backlog/copy'
import type { WorkOnReasons } from '@/types/backlog'

function WorkOnBlockers({ reasons }: { readonly reasons: WorkOnReasons }) {
  return (
    <>
      <p>{backlogBlockedReasonCopy(reasons.blockers.length)}</p>
      <ul className="list-inside list-disc">
        {reasons.blockers.map((blocker) => (
          <li key={blocker.number}>
            <a href={blocker.url} target="_blank" rel="noreferrer" className="text-primary-text hover:underline">
              {backlogBlockerLine(blocker)}
            </a>
          </li>
        ))}
      </ul>
      {reasons.truncation !== null ? <p>{backlogBlockerTruncatedCopy(reasons.truncation.shown, reasons.truncation.total)}</p> : null}
    </>
  )
}

export function workOnConfirmSpec(number: number, reasons: WorkOnReasons): ConfirmSpec {
  return {
    title: backlogStartAnywayTitle(number),
    description: <WorkOnBlockers reasons={reasons} />,
    confirmLabel: BACKLOG_START_ANYWAY,
  }
}
