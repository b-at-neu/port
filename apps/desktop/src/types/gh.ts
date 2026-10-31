// Renderer-safe contract for the footer's gh status dot; no import here may reach a Node builtin.

// `unknown` covers a gh failure that is neither a clean sign-in/sign-out read nor a missing binary; never thrown.
// `account` and `scopes` are `null`, never a guess, when `gh auth status` output could not be parsed.
export type GhStatus =
  | { readonly kind: 'signed-in'; readonly checkedAt: string; readonly account: string | null; readonly scopes: readonly string[] | null }
  | { readonly kind: 'signed-out'; readonly checkedAt: string }
  | { readonly kind: 'missing'; readonly checkedAt: string }
  | { readonly kind: 'unknown'; readonly message: string; readonly checkedAt: string }
