// Narrowing helpers for the loosely-typed objects GitHub's responses parse into.
export type Obj = Readonly<Record<string, unknown>>

export function obj(value: unknown): Obj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function nodesOf(value: unknown): readonly Obj[] {
  const nodes = obj(value)?.nodes
  return Array.isArray(nodes) ? nodes.flatMap((node) => (obj(node) === null ? [] : [node as Obj])) : []
}
