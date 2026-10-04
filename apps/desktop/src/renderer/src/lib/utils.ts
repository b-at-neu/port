import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** The four DESIGN §2 type-size tokens are custom `font-size` utilities
 *  (`theme.css`'s `@theme inline`), not Tailwind's own scale — without this
 *  registration `tailwind-merge` reads `text-body` as a colour utility and
 *  drops it whenever a `text-*` colour class sits beside it in the same
 *  `cn()` call. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': ['text-meta', 'text-small', 'text-body', 'text-title']
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
