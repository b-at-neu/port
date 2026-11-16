export interface DisplayInput {
  platform: string
  hasXvfb: boolean
  hasDisplay: boolean
}

export type DisplayPlan = { kind: 'xvfb' } | { kind: 'refuse' | 'desktop'; lines: string[] }

export declare function displayPlan(input: DisplayInput): DisplayPlan
