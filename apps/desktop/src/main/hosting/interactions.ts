// Narrows `AskUserQuestion`/`ExitPlanMode` canUseTool calls away from the
// generic dialog, and builds the PermissionResults their answers send back.
import { isRecord } from '../../shared/guards'
import type { AskQuestion, AskQuestionOption, PendingInteraction } from '../../shared/hosting/controls'
import type { PermissionResult, PermissionUpdate } from './sdk'

function narrowOption(value: unknown): AskQuestionOption | null {
  if (!isRecord(value) || typeof value['label'] !== 'string' || value['label'] === '') return null
  const description = value['description']
  return { label: value['label'], description: typeof description === 'string' ? description : null }
}

function narrowQuestion(value: unknown): AskQuestion | null {
  if (!isRecord(value) || typeof value['question'] !== 'string' || typeof value['header'] !== 'string') return null
  const rawOptions = value['options']
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null
  const options: AskQuestionOption[] = []
  for (const raw of rawOptions) {
    const option = narrowOption(raw)
    if (option === null) return null
    options.push(option)
  }
  return { question: value['question'], header: value['header'], multiSelect: value['multiSelect'] === true, options }
}

function narrowAskUserQuestion(input: Readonly<Record<string, unknown>>): PendingInteraction | null {
  const rawQuestions = input['questions']
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    const question = narrowQuestion(raw)
    if (question === null) return null
    questions.push(question)
  }
  return { kind: 'question', questions }
}

function narrowExitPlanMode(input: Readonly<Record<string, unknown>>): PendingInteraction {
  // The CLI injects `plan` at runtime; a missing or non-string value falls back to null.
  const plan = input['plan']
  return { kind: 'plan', plan: typeof plan === 'string' ? plan : null }
}

// `toolName` is read verbatim from the SDK's own canUseTool call, never namespace-qualified.
export function narrowInteraction(toolName: string, input: Readonly<Record<string, unknown>>): PendingInteraction | null {
  if (toolName === 'AskUserQuestion') return narrowAskUserQuestion(input)
  if (toolName === 'ExitPlanMode') return narrowExitPlanMode(input)
  return null
}

export function questionResult(input: Readonly<Record<string, unknown>>, answers: Readonly<Record<string, string>>, toolUseID: string): PermissionResult {
  return { behavior: 'allow', updatedInput: { ...input, answers }, toolUseID }
}

export function planApproveResult(input: Readonly<Record<string, unknown>>, mode: 'default' | 'acceptEdits', toolUseID: string): PermissionResult {
  const update: PermissionUpdate = { type: 'setMode', mode, destination: 'session' }
  return { behavior: 'allow', updatedInput: input, updatedPermissions: [update], toolUseID }
}

export function planKeepResult(feedback: string, toolUseID: string): PermissionResult {
  return { behavior: 'deny', message: feedback, toolUseID }
}

export function questionTextsOf(interaction: Extract<PendingInteraction, { kind: 'question' }>): readonly string[] {
  return interaction.questions.map((question) => question.question)
}

export function answersMatch(interaction: Extract<PendingInteraction, { kind: 'question' }>, answers: Readonly<Record<string, string>>): boolean {
  const expected = questionTextsOf(interaction)
  const provided = Object.keys(answers)
  if (expected.length !== provided.length) return false
  return expected.every((text) => Object.prototype.hasOwnProperty.call(answers, text))
}
