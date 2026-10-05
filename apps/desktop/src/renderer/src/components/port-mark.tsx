// DESIGN §8 — the sailboat mark, in a 20px `brand` tile. `markPaths` reads
// the canonical SVG's own `<path d>` values rather than a second
// hand-copied shape, so the two can never drift (ENGINEERING §2).
import { cn } from '@/lib/utils'
import portMarkSvg from '../../../../../../docs/design/port-mark.svg?raw'

/** Pure: extracts every `<path d="…">` value, in document order. */
export function markPaths(svg: string): readonly string[] {
  const matches = svg.matchAll(/<path\s+d="([^"]+)"/g)
  return Array.from(matches, (match) => match[1] ?? '')
}

export interface PortMarkProps {
  readonly className?: string
}

export function PortMark({ className }: PortMarkProps) {
  const paths = markPaths(portMarkSvg)
  return (
    <span className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-brand-border bg-brand text-brand-foreground', className)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="size-[70%]" aria-hidden="true">
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  )
}
