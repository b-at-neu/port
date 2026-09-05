import type { PortBridge } from './index'

declare global {
  interface Window {
    port: PortBridge
  }
}

export {}
