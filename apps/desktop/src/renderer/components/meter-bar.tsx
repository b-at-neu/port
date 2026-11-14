const FILL = { primary: 'bg-primary-text', success: 'bg-success-dot' } as const

export function MeterBar({ percent, fill }: { readonly percent: number | null; readonly fill: keyof typeof FILL }) {
  return (
    <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-border">
      {percent !== null ? <span aria-hidden="true" className={`block h-full rounded-full ${FILL[fill]}`} style={{ width: `${String(percent)}%` }} /> : null}
    </span>
  )
}
