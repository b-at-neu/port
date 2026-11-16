// The one `update:state` reader; it polls only while the startup check can still change the answer.
import { useIpcQuery } from '@/renderer/data/query'

const POLL_MS = 1000

export function useUpdateState() {
  return useIpcQuery('update:state', undefined, { refetchInterval: (data) => (data?.kind === 'idle' || data?.kind === 'checking' ? POLL_MS : false) })
}
