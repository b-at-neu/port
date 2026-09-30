// #103: the rail's own limit state — split out of session/controller.ts to
// stay under the file-size limit (ENGINEERING §7). `onChange` is always
// `controller.ts`'s own `draw`, passed in rather than imported, so this
// module stays free of any dependency back on the controller.
import type { HostingCapacity } from '../../../shared/hosting/types'
import { CAPACITY_SET_FAILED } from './rail-copy'

export interface CapacityState {
  readonly limit: number
  readonly ceiling: number
  readonly error: string | null
}

let limit = 4
let ceiling = 8
let error: string | null = null

export function capacityState(): CapacityState {
  return { limit, ceiling, error }
}

export async function loadCapacity(onChange: () => void): Promise<void> {
  try {
    const capacity = await window.port.sessionCapacity()
    limit = capacity.limit
    ceiling = capacity.ceiling
    onChange()
  } catch (err) {
    console.error('Failed to load the session capacity', err)
  }
}

async function applyLimit(next: number, onChange: () => void): Promise<void> {
  try {
    const capacity: HostingCapacity = await window.port.sessionCapacitySet({ limit: next })
    limit = capacity.limit
    ceiling = capacity.ceiling
    error = null
  } catch (err) {
    console.error('Failed to reach the main process changing the session limit', err)
    error = CAPACITY_SET_FAILED
  }
  onChange()
}

export function incrementLimit(onChange: () => void): void {
  void applyLimit(Math.min(ceiling, limit + 1), onChange)
}

export function decrementLimit(onChange: () => void): void {
  void applyLimit(Math.max(1, limit - 1), onChange)
}
