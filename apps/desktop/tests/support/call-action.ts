// Runs an action exactly as the router does — parse the raw request, then `run` — against whatever context a test builds.
import type { AppContext } from '@/main/app/context'
import { actions } from '@/main/app/router'
import type { ActionInput, ActionName, ActionOutput } from '@/types/ipc'

export async function callAction<N extends ActionName>(ctx: Partial<AppContext>, name: N, input?: ActionInput<N>): Promise<ActionOutput<N>> {
  const action = actions.find((candidate) => candidate.name === name)
  if (action === undefined) throw new Error(`no action named '${name}'`)
  const run = action.run as (ctx: AppContext, input: unknown) => unknown
  return (await run(ctx as AppContext, action.input.parse(input))) as ActionOutput<N>
}
