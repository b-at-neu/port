// The one session row (DESIGN §4's `SessionRow`) — Your sessions, History and a pipeline's nested stage sessions all render through it.
import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/renderer/lib/utils'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/renderer/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { SessionMarkContextItems, SessionMarkMenu, SessionPinGlyph, useSessionMarkMenu } from '@/renderer/components/session-mark-menu'
import { SELECTED_ROW_CLASS } from '@/renderer/shell/sidebar-selection'
import type { SessionMarks } from '@/types/hosting'

type Density = 'sidebar' | 'nested' | 'list'

interface RowMarks {
  readonly sessionId: string | null
  readonly marks: SessionMarks | undefined
  readonly onRename?: () => void
}

interface SessionRowProps {
  readonly density: Density
  readonly title: string
  readonly onOpen: () => void
  readonly leading?: ReactNode
  readonly meta?: string
  readonly statusText?: string
  readonly tooltip?: { readonly title: string; readonly line: string }
  readonly selected?: boolean
  readonly trailing?: ReactNode
  readonly marks: RowMarks | null
  readonly children?: ReactNode
}

const OPEN_BUTTON_CLASS = 'flex min-w-0 items-center text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring rounded-md'

function OpenButton({ props, pinned }: { readonly props: SessionRowProps; readonly pinned: boolean }) {
  const { density, title, meta, statusText, selected, leading, onOpen } = props
  const button = (
    <button
      type="button"
      aria-current={selected === true ? 'page' : undefined}
      onClick={onOpen}
      className={cn(
        OPEN_BUTTON_CLASS,
        density === 'sidebar' && 'flex-1 gap-2 px-2 py-1',
        density === 'nested' && 'h-6.5 w-full gap-1.5 py-0 pr-2 pl-8 text-small text-foreground-secondary',
        density === 'list' && 'flex-1 gap-2',
        density === 'nested' && selected === true && SELECTED_ROW_CLASS,
      )}
    >
      {leading}
      {pinned ? <SessionPinGlyph /> : null}
      <span className={cn('truncate', density === 'sidebar' && 'flex-1', density === 'list' && 'text-small')}>{title}</span>
      {statusText !== undefined ? <span className="sr-only">{statusText}</span> : null}
      {meta !== undefined ? <span className="shrink-0 truncate text-meta text-muted-foreground">{meta}</span> : null}
    </button>
  )
  if (props.tooltip === undefined) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">
        <div className="break-words font-medium">{props.tooltip.title}</div>
        <div className="opacity-80">{props.tooltip.line}</div>
      </TooltipContent>
    </Tooltip>
  )
}

interface RowFrameProps {
  readonly props: SessionRowProps
  readonly pinned: boolean
  readonly menu: ReactNode
  readonly contextTrigger: (line: ReactElement) => ReactElement
}

function RowFrame({ props, pinned, menu, contextTrigger }: RowFrameProps) {
  const { density, selected, trailing, children } = props
  const button = <OpenButton props={props} pinned={pinned} />
  if (density === 'nested') return <div data-slot="session-row">{contextTrigger(<div className="contents">{button}</div>)}</div>
  if (density === 'sidebar') {
    return contextTrigger(
      <div data-slot="session-row" className={cn('group/row flex h-7 w-full items-center gap-1 rounded-md pr-1 text-body text-foreground-secondary', selected === true && SELECTED_ROW_CLASS)}>
        {button}
        <div className="shrink-0 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-has-[[data-state=open]]/row:opacity-100">{menu}</div>
      </div>,
    )
  }
  return (
    <div className="flex flex-col" data-slot="session-row">
      {contextTrigger(
        <div className="flex h-9 items-center gap-2 px-4">
          {button}
          {trailing}
          {menu}
        </div>,
      )}
      {children}
    </div>
  )
}

const NO_CONTEXT_TRIGGER = (line: ReactElement) => line

function MarkedSessionRow({ props, marks }: { readonly props: SessionRowProps; readonly marks: RowMarks }) {
  const model = useSessionMarkMenu(marks)
  return (
    <>
      <ContextMenu>
        <RowFrame
          props={props}
          pinned={model.pinned}
          menu={<SessionMarkMenu items={model.items} select={model.select} />}
          contextTrigger={(line) => <ContextMenuTrigger asChild>{line}</ContextMenuTrigger>}
        />
        <ContextMenuContent>
          <SessionMarkContextItems items={model.items} select={model.select} />
        </ContextMenuContent>
      </ContextMenu>
      {model.dialog}
    </>
  )
}

export function SessionRow(props: SessionRowProps) {
  if (props.marks === null) return <RowFrame props={props} pinned={false} menu={null} contextTrigger={NO_CONTEXT_TRIGGER} />
  return <MarkedSessionRow props={props} marks={props.marks} />
}
