// Mounts the React tree into `#react-root`, beside the legacy DOM `main.ts`
// still owns (#316). `StrictMode` › `QueryClientProvider` › `TooltipProvider`
// › `RouterProvider` — the CSP does not change, since everything here is a
// bundled module, not an inline script.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { router } from '../router/router'

export function mountReact(container: HTMLElement, client: QueryClient): void {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}
