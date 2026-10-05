// Lets `ShellLayout` portal the route `<Outlet/>` into `#react-root` without a DOM query of its own.
import { createContext, useContext } from 'react'

const PortalTargetContext = createContext<HTMLElement | null>(null)

export const PortalTargetProvider = PortalTargetContext.Provider

export function usePortalTarget(): HTMLElement | null {
  return useContext(PortalTargetContext)
}
