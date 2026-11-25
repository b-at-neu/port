// The expanded body of a Needs you row, one branch per kind that has detail.
import { useState } from 'react'
import { Button } from '@/renderer/components/ui/button'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { openSession } from '@/renderer/app/navigation'
import { QuestionCard } from '@/renderer/session/question-card'
import { QUESTION_SKIPPED_MESSAGE } from '@/renderer/session/copy'
import { CLEANUP_FAILED_HELP, ENDED_DENIAL_LINE, LAUNCH_FAILED_HELP, LAUNCH_FAILED_NO_DETAIL, OPEN_SESSION_LABEL, PROTECTED_PATH_HELP, SHARED_FILES_LABEL, usageLimitEntryLine } from '@/renderer/needs-you/copy'
import type { NeedsYouItem } from '@/types/board'

function StageQuestionCard({ item }: { readonly item: Extract<NeedsYouItem, { readonly kind: 'stage-question' }> }) {
  const [error, setError] = useState<string | null>(null)
  const answer = useActionMutation('session.questionAnswer')
  const skip = useActionMutation('session.permissionAnswer')

  async function send(answers: Record<string, string>): Promise<void> {
    setError(null)
    const result = await answer.perform({ sessionKey: item.sessionKey, permissionId: item.permissionId, answers })
    if (result === 'unreachable') setError('unreachable')
    else if (!result.ok) setError(result.kind)
  }

  return (
    <QuestionCard
      questions={item.questions}
      sending={answer.pending}
      error={error}
      onSend={(answers) => void send(answers)}
      onSkip={() => void skip.perform({ sessionKey: item.sessionKey, permissionId: item.permissionId, decision: 'deny', message: QUESTION_SKIPPED_MESSAGE })}
    />
  )
}

export function DetailBody({ item }: { readonly item: NeedsYouItem }) {
  if (item.kind === 'held' && item.held.contention !== null) {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p>{SHARED_FILES_LABEL}</p>
        <ul className="list-inside list-disc">
          {item.held.contention.paths.map((path) => (
            <li key={path} className="font-mono">
              {path}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (item.kind === 'usage-limit') {
    return (
      <ul className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        {item.entries.map((entry) => (
          <li key={entry.id}>{usageLimitEntryLine(item, entry)}</li>
        ))}
      </ul>
    )
  }
  if (item.kind === 'stage-question') {
    return (
      <div className="border-t border-border px-4 py-2">
        <StageQuestionCard item={item} />
      </div>
    )
  }
  if (item.kind === 'stage-denial') {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p className="font-mono">
          {item.denial.toolName}: {item.denial.inputSummary}
        </p>
        {item.live ? null : <p>{ENDED_DENIAL_LINE}</p>}
      </div>
    )
  }
  if (item.kind === 'dispatch-failed') {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p className="whitespace-pre-wrap break-words font-mono">{item.record.detail ?? LAUNCH_FAILED_NO_DETAIL}</p>
        <p>{LAUNCH_FAILED_HELP}</p>
      </div>
    )
  }
  if (item.kind === 'stage-interrupted') {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p className="whitespace-pre-wrap break-words font-mono">{item.interrupted.worktree.path}</p>
        <p>{CLEANUP_FAILED_HELP}</p>
      </div>
    )
  }
  if (item.kind === 'stage-approval') {
    return (
      <div className="flex items-start justify-between gap-3 border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <div>
          <p className="font-mono">
            {item.toolName}: {item.path}
          </p>
          <p>{PROTECTED_PATH_HELP}</p>
        </div>
        <Button variant="ghost" size="small" onClick={() => openSession(item.sessionKey)}>
          {OPEN_SESSION_LABEL}
        </Button>
      </div>
    )
  }
  return null
}
