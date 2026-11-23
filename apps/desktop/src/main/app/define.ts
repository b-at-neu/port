import type { z } from 'zod'
import type { AppContext } from '@/main/app/context'

export type ActionKind = 'query' | 'mutation'

export interface Action<N extends string = string, K extends ActionKind = ActionKind, I extends z.ZodType = z.ZodType, O = unknown> {
  readonly name: N
  readonly kind: K
  /** The whole request contract: the router parses every call through it before `run`. A call with no payload uses `z.undefined()`. */
  readonly input: I
  readonly run: (ctx: AppContext, input: z.output<I>) => O | Promise<O>
}

export function defineAction<const N extends string, const K extends ActionKind, I extends z.ZodType, O>(action: Action<N, K, I, O>): Action<N, K, I, O> {
  return action
}

export interface EventToken<N extends string, P> {
  readonly name: N
  readonly payload?: P
}

/** A main → renderer push; the payload type travels with the token. */
export function defineEvent<P>(): <const N extends string>(name: N) => EventToken<N, P> {
  return (name) => ({ name })
}
