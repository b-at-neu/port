// A `catch` binding types as `unknown` under `strict`, and every one of this
// tree's dozen `catch (e)` sites just wants `e.message` — one helper instead
// of a cast at each site.
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
