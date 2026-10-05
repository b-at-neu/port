// Renderer-safe contract for the footer's gh status dot. No import here may
// reach a Node builtin, so this file compiles under tsconfig.web.json too.

// `unknown` covers a gh failure that is neither a clean sign-in/sign-out read
// nor a missing binary; it renders idle, never green. Never thrown.
export type GhStatus =
  | { readonly kind: 'signed-in'; readonly checkedAt: string }
  | { readonly kind: 'signed-out'; readonly checkedAt: string }
  | { readonly kind: 'missing'; readonly checkedAt: string }
  | { readonly kind: 'unknown'; readonly message: string; readonly checkedAt: string }
