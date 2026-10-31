// A `catch` binding types as `unknown` under `strict`; one helper instead of a cast at each site.
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
