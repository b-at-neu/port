import { describe, expect, it } from 'vitest'
import type { PhaseSegmentState } from '@/types/board'
import type { StageAgent } from '@/types/tick'
import {
  STAGE_TABLE,
  agentPhase,
  agentStage,
  agentStageName,
  columnOf,
  needsYouKindOf,
  phaseOf,
  phaseSegmentsOf,
  sectionOf,
  stageGroupOf,
  stageNameOf,
  stageRowOf,
  waitsOnYou,
} from '@/utils/pipeline/stages'
import type { StageStatus, TicketView } from '@/utils/pipeline/stages'
import { STAGES, STATUS_KINDS, gateSchema, queueReasonSchema } from '@/utils/pipeline/ticket'
import type { Stage } from '@/utils/pipeline/ticket'

const view = (stage: Stage, status: StageStatus): TicketView => ({ stage, status })
const queued = (stage: Stage, reason: 'new' | 'changes-requested' | 'retry' = 'new') => view(stage, { kind: 'queued', reason })
const running = (stage: Stage) => view(stage, { kind: 'running' })
const waiting = (stage: Stage, gate: (typeof gateSchema.options)[number]) => view(stage, { kind: 'waiting-on-you', gate })
const blocked = (stage: Stage) => view(stage, { kind: 'blocked' })
const MERGED = view('merge', { kind: 'done' })
const CALM = { autoApproving: false, blocked: false }

describe('stageRowOf', () => {
  it.each([
    [queued('plan'), 'Queued', 'plan', 'queued', null, 'plan'],
    [queued('plan', 'changes-requested'), 'Replanning', 'plan', 'plan', null, 'plan'],
    [running('plan'), 'Planning', 'plan', 'plan', null, 'plan'],
    [waiting('plan', 'plan-approval'), 'Plan review', 'plan', 'plan', 'plan-review', 'plan'],
    [queued('implement'), 'Plan approved', 'implement', 'implement', null, 'implement'],
    [running('implement'), 'Implementing', 'implement', 'implement', null, 'implement'],
    [queued('review'), 'Waiting for review', 'review', 'review', null, 'review'],
    [queued('revise', 'changes-requested'), 'Needs revision', 'revision', 'revise', null, 'revise'],
    [running('revise'), 'Revising', 'revision', 'revise', null, 'revise'],
    [queued('refresh'), 'Refreshing', 'revision', 'revise', null, 'refresh'],
    [running('refresh'), 'Refreshing', 'revision', 'revise', null, 'refresh'],
    [waiting('merge', 'merge'), 'Ready to merge', 'merge', 'needs-you', 'ready-to-merge', 'done'],
    [waiting('implement', 'escalation'), 'Needs you', 'implement', 'implement', 'needs-human', 'needs-you'],
    [waiting('review', 'escalation'), 'Needs you', 'review', 'review', 'needs-human', 'needs-you'],
    [waiting('review', 'question'), 'Needs you', 'review', 'review', null, 'needs-you'],
    [blocked('implement'), 'Blocked', 'implement', 'queued', 'blocked', 'needs-you'],
    [blocked('review'), 'Blocked', 'review', 'queued', 'blocked', 'needs-you'],
    [MERGED, 'Merged', 'merge', 'needs-you', null, 'done'],
  ] as const)('%#: %s', (v, name, phase, column, needsYou, palette) => {
    expect(stageRowOf(v)).toMatchObject({ name, phase, column, needsYou, palette })
  })

  it('an absent view is unstaged: no phase, the queued column, no palette', () => {
    expect(stageRowOf(null)).toMatchObject({ name: 'Unstaged', phase: null, column: 'queued', needsYou: null, palette: null })
  })

  it('held copies the queued cell for every stage', () => {
    for (const stage of STAGES) expect(STAGE_TABLE[stage].held).toBe(STAGE_TABLE[stage].queued)
  })

  it('every cell of every stage is defined', () => {
    for (const stage of STAGES) for (const kind of STATUS_KINDS) expect(STAGE_TABLE[stage][kind].name).not.toBe('')
  })

  it('only escalation and blocked cells draw attention, and every gate escalates in the needs-you palette', () => {
    for (const gate of gateSchema.options) {
      const row = stageRowOf(waiting('plan', gate))
      expect(row.attention).toBe(gate !== 'plan-approval' && gate !== 'merge')
    }
    expect(stageRowOf(running('implement')).attention).toBe(false)
    expect(stageRowOf(blocked('plan')).attention).toBe(true)
  })
})

describe('columnOf', () => {
  it.each([
    ['waits on you', waiting('plan', 'plan-approval'), CALM, 'needs-you'],
    ['auto-approving plan review stays in Plan', waiting('plan', 'plan-approval'), { autoApproving: true, blocked: false }, 'plan'],
    ['a blocked row goes to Queued', running('implement'), { autoApproving: false, blocked: true }, 'queued'],
    ['waiting beats blocked', waiting('review', 'escalation'), { autoApproving: false, blocked: true }, 'needs-you'],
    ['refresh is revise work', queued('refresh'), CALM, 'revise'],
    ['merge work is the operator’s', queued('merge'), CALM, 'needs-you'],
    ['unstaged', null, CALM, 'queued'],
  ] as const)('%s', (_name, v, context, column) => {
    expect(columnOf(v, context)).toBe(column)
  })
})

describe('sectionOf', () => {
  it.each([
    [waiting('merge', 'merge'), { ...CALM, working: false }, 'waiting-on-you'],
    [running('implement'), { autoApproving: false, blocked: true, working: true }, 'blocked'],
    [waiting('plan', 'plan-approval'), { autoApproving: true, blocked: false, working: false }, 'in-progress'],
    [running('implement'), { ...CALM, working: true }, 'in-progress'],
    [queued('review'), { ...CALM, working: false }, 'queued'],
  ] as const)('%#', (v, context, section) => {
    expect(sectionOf(v, context)).toBe(section)
  })
})

describe('waitsOnYou and needsYouKindOf', () => {
  it('waits only on a gate, and an auto-approval clears it', () => {
    expect(waitsOnYou(waiting('plan', 'plan-approval'), false)).toBe(true)
    expect(waitsOnYou(waiting('plan', 'plan-approval'), true)).toBe(false)
    expect(waitsOnYou(blocked('implement'), false)).toBe(false)
    expect(waitsOnYou(null, false)).toBe(false)
  })

  it('a blocked ticket still lists in Needs you, but auto-approving clears the kind', () => {
    expect(needsYouKindOf(blocked('implement'), false)).toBe('blocked')
    expect(needsYouKindOf(waiting('plan', 'plan-approval'), false)).toBe('plan-review')
    expect(needsYouKindOf(waiting('plan', 'plan-approval'), true)).toBeNull()
    expect(needsYouKindOf(running('plan'), false)).toBeNull()
  })

  it('every view agrees: a waiting ticket sits in Needs you and every staged view has a phase', () => {
    const views: TicketView[] = []
    for (const stage of STAGES) {
      for (const reason of queueReasonSchema.options) views.push(queued(stage, reason))
      for (const gate of gateSchema.options) views.push(waiting(stage, gate))
      views.push(running(stage), blocked(stage), view(stage, { kind: 'held' }), view(stage, { kind: 'done' }))
    }
    for (const v of views) {
      expect(phaseOf(v)).not.toBeNull()
      if (v.status.kind === 'waiting-on-you') expect(columnOf(v, CALM)).toBe('needs-you')
      expect(stageNameOf(v)).toBe(stageRowOf(v).name)
    }
  })
})

describe('phaseSegmentsOf', () => {
  const states = (v: TicketView | null): PhaseSegmentState[] => phaseSegmentsOf(v).map((s) => s.state)

  it('unstaged is all pending', () => {
    expect(states(null)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending'])
  })

  it('plan running is the first segment, in the plan palette', () => {
    expect(states(running('plan'))).toEqual(['current-working', 'pending', 'pending', 'pending', 'pending'])
    expect(phaseSegmentsOf(running('plan'))[0]?.palette).toBe('plan')
  })

  it('an escalation is current-attention in the needs-you palette, earlier phases finished', () => {
    const segments = phaseSegmentsOf(waiting('review', 'escalation'))
    expect(segments.map((s) => s.state)).toEqual(['finished', 'finished', 'current-attention', 'pending', 'pending'])
    expect(segments[2]?.palette).toBe('needs-you')
    expect(segments[1]?.palette).toBe('implement')
  })

  it('refresh makes the revision segment current in the refresh palette', () => {
    const segments = phaseSegmentsOf(running('refresh'))
    expect(segments.map((s) => s.state)).toEqual(['finished', 'finished', 'finished', 'current-working', 'pending'])
    expect(segments[3]?.palette).toBe('refresh')
  })

  it('done is every phase complete', () => {
    expect(states(MERGED)).toEqual(['complete', 'complete', 'complete', 'complete', 'complete'])
  })
})

describe('stageGroupOf', () => {
  it('ranks by stage, then status kind, then reason or gate, with unstaged last', () => {
    const ordered = [queued('plan'), queued('plan', 'changes-requested'), running('plan'), waiting('plan', 'plan-approval'), blocked('plan'), queued('implement'), queued('refresh'), queued('merge')]
    const ranks = ordered.map((v) => stageGroupOf(v).rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(ranks).size).toBe(ranks.length)
    expect(stageGroupOf(null)).toMatchObject({ key: 'unstaged' })
    expect(stageGroupOf(null).rank).toBeGreaterThan(Math.max(...ranks))
  })

  it('keys carry the reason or gate only where there is one', () => {
    expect(stageGroupOf(queued('plan', 'changes-requested')).key).toBe('plan:queued:changes-requested')
    expect(stageGroupOf(waiting('merge', 'merge')).key).toBe('merge:waiting-on-you:merge')
    expect(stageGroupOf(running('review')).key).toBe('review:running')
  })
})

describe('agent lookups', () => {
  it.each([
    ['plan', 'plan', 'Planning', 'plan'],
    ['impl', 'implement', 'Implementing', 'implement'],
    ['review', 'review', 'Reviewing', 'review'],
    ['revise', 'revise', 'Revising', 'revision'],
  ] as const)('%s agent', (agent: StageAgent, stage, name, phase) => {
    expect(agentStage(agent)).toBe(stage)
    expect(agentStageName(agent)).toBe(name)
    expect(agentPhase(agent)).toBe(phase)
  })
})
