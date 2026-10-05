// `mount.tsx` provides `#react-root` itself through this context, so
// `shell/layout.tsx`'s `ShellLayout` can portal the route `<Outlet/>` into
// it without either file importing a DOM query of its own.
import { createContext, useContext } from 'react'

const PortalTargetContext = createContext<HTMLElement | null>(null)

export const PortalTargetProvider = PortalTargetContext.Provider

export function usePortalTarget(): HTMLElement | null {
  return useContext(PortalTargetContext)
}
