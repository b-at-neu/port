import { describe, expect, it } from 'vitest'
import { ISSUE_BODY_GUARD_MESSAGE, LABEL_GUARD_MESSAGE, issueBodyWriteOf, labelWriteOf } from '@/main/sessions/hosting/label-guard'

describe('labelWriteOf', () => {
  it.each([
    'gh issue edit 52 --repo o/a --add-label "in progress"',
    'gh issue edit 52 --repo o/a --remove-label "planning" --add-label "plan review"',
    'gh pr edit 8 --repo o/a --add-label "ready for review"',
    'gh pr edit 8 --remove-label reviewing',
    'gh issue edit 52 --add-label=blocked',
    'gh pr create --repo o/a --base dev --title t --body-file .temp/pr-52.md --label claude',
    'gh pr create --repo o/a --base dev --title t --body-file .temp/pr-52.md -l claude',
    'gh issue create --title t --label bug',
    'gh api repos/o/a/issues/52/labels -f "labels[]=planning"',
    'gh api -X DELETE repos/o/a/issues/52/labels/planning',
    'gh api -X POST repos/o/a/issues/8/labels --input .temp/labels.json',
  ])('denies %s', (command) => {
    expect(labelWriteOf(command)).not.toBeNull()
  })

  it.each([
    'gh pr view 8 --repo o/a --json labels',
    'gh issue view 52 --repo o/a --json labels,title,assignees',
    'gh pr view 8 --repo o/a --json labels --jq ".labels[].name"',
    'gh pr create --repo o/a --base dev --title t --body-file .temp/pr-52.md --assignee b-at-neu --head 52-thing',
    'gh issue edit 52 --repo o/a --body-file .temp/plan-52.md',
    'gh issue comment 52 --repo o/a --body-file .temp/blocker-52.md',
    'gh pr list --repo o/a --label "ready for review"',
    'gh issue list --repo o/a --label planning',
    'gh api repos/o/a/issues/52/comments',
    'gh api repos/o/a/pulls/8/reviews --input .temp/review-8.json',
    'git push origin HEAD:52-thing',
    'node scripts/checks.ts',
  ])('allows %s', (command) => {
    expect(labelWriteOf(command)).toBeNull()
  })

  it('names the form it matched', () => {
    expect(labelWriteOf('gh pr edit 8 --add-label x')).toBe('gh edit label flag')
    expect(labelWriteOf('gh pr create --label x')).toBe('gh create --label')
    expect(labelWriteOf('gh api repos/o/a/issues/1/labels')).toBe('gh api issues labels')
  })

  it('carries the reason the agent sees', () => {
    expect(LABEL_GUARD_MESSAGE).toBe("port moves pipeline labels itself. Don't edit labels — finish with your HANDBACK: line.")
  })
})

describe('issueBodyWriteOf', () => {
  it.each([
    'gh issue edit 52 --repo o/a --body-file .temp/plan-52.md',
    'gh issue edit 52 --repo o/a --body "new body"',
    'gh issue edit 52 --body-file=.temp/plan-52.md',
    'gh issue edit 52 -b x',
    'gh issue edit 52 -F .temp/plan-52.md',
    'gh api repos/o/a/issues/52 -X PATCH -F body=@.temp/p.md',
    'gh api --method PATCH repos/o/a/issues/52 -f body=x',
    'gh api repos/o/a/issues/52 --input .temp/p.json',
    'gh api "repos/o/a/issues/52" -f body=x',
  ])('denies %s', (command) => {
    expect(issueBodyWriteOf(command)).toBe(true)
  })

  it.each([
    'gh issue comment 52 --body-file .temp/b.md',
    'gh issue view 52 --json body',
    'gh issue edit 52 --repo o/a --add-label planning',
    'gh pr edit 8 --body-file .temp/pr-body-8.md',
    'gh pr create --repo o/a --base dev --title t --body-file .temp/pr-52.md',
    'gh api repos/o/a/issues/52',
    'gh api repos/o/a/issues/52/comments -f body=x',
    'gh api repos/o/a/issues/52/comments --input .temp/c.json',
    'gh api repos/o/a/pulls/8/reviews --input .temp/review-8.json',
    'git push origin HEAD:52-thing',
  ])('allows %s', (command) => {
    expect(issueBodyWriteOf(command)).toBe(false)
  })

  it('carries the reason the agent sees', () => {
    expect(ISSUE_BODY_GUARD_MESSAGE).toBe('port posts the plan itself. Write it to .temp/plan-<N>.md and finish with your HANDBACK: line.')
  })
})
