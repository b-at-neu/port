// The −/n/+ stepper shared by the session menu and Settings → Pipeline.
import { Button } from '@/renderer/components/ui/button'

interface LimitStepperProps {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly label: string
  readonly onChange: (next: number) => void
  readonly disabled?: boolean
}

export function LimitStepper({ value, min, max, label, onChange, disabled = false }: LimitStepperProps) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <Button variant="outline" size="small" aria-label={`Decrease ${label.toLowerCase()}`} disabled={disabled || value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </Button>
      <span className="w-4 text-center text-small tabular-nums">{value}</span>
      <Button variant="outline" size="small" aria-label={`Increase ${label.toLowerCase()}`} disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </Button>
    </div>
  )
}
