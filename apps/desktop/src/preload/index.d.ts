import type { PortBridge } from '@/preload/index'

declare global {
  interface Window {
    port: PortBridge
  }
}

export {}
