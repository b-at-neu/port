const FILL = { primary: 'bg-primary-text', success: 'bg-success-dot', progress: 'bg-phase-review-dot' } as const

export interface MeterSegment {
  readonly percent: number
  readonly fill: keyof typeof FILL
}

export function MeterBar({ segments }: { readonly segments: readonly MeterSegment[] }) {
  return (
    <span className="flex h-1 w-14 shrink-0 overflow-hidden rounded-full bg-border">
      {segments
        .filter((segment) => segment.percent > 0)
        .map((segment) => (
          <span key={segment.fill} aria-hidden="true" data-slot="meter-segment" data-fill={segment.fill} className={`h-full ${FILL[segment.fill]}`} style={{ width: `${String(segment.percent)}%` }} />
        ))}
    </span>
  )
}
