// The one mounted list screen's J/K/Enter/Esc handlers, set on commit by a ref callback and never during render.
export interface ListNavigator {
  next(): void
  prev(): void
  open(): void
  close?(): void
}

let active: ListNavigator | null = null

/** A new callback each render makes React swap the navigator at commit time. */
export function listNavigatorRef(navigator: ListNavigator): () => () => void {
  return () => {
    active = navigator
    return () => {
      if (active === navigator) active = null
    }
  }
}

export function currentListNavigator(): ListNavigator | null {
  return active
}
