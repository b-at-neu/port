// The one `update:download:state` reader; it polls only while a download is running.
import { useIpcQuery } from '@/renderer/data/query'

const POLL_MS = 500

export function useUpdateDownload() {
  return useIpcQuery('update:download:state', undefined, { refetchInterval: (data) => (data?.kind === 'downloading' ? POLL_MS : false) })
}
