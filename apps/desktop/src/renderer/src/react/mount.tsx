// Mounts the React tree into `#shell-root` (#316, moved from `#react-root` —
// the frame itself is React now; `#react-root` is a portal target beside the
// legacy DOM `main.ts` still owns in `#main-area`). `StrictMode` ›
// `QueryClientProvider` › `TooltipProvider` › `PortalTargetProvider` ›
// `RouterProvider` — the CSP does not change, since everything here is a
// bundled module, not an inline script.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { router } from '../router/router'
import { PortalTargetProvider } from './portal-target'

export function mountReact(shellRoot: HTMLElement, reactRoot: HTMLElement, client: QueryClient): void {
  createRoot(shellRoot).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <PortalTargetProvider value={reactRoot}>
            <RouterProvider router={router} />
          </PortalTargetProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}
