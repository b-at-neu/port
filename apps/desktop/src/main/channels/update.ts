import type { UpdateService, UpdateState } from '@/types/update'

export function resolveUpdateState(request: unknown, service: UpdateService): UpdateState {
  if (request !== undefined) throw new Error("'update:state' takes no payload")
  return service.state()
}

export function resolveUpdateCheck(request: unknown, service: UpdateService): Promise<UpdateState> {
  if (request !== undefined) throw new Error("'update:check' takes no payload")
  return service.check('manual')
}
