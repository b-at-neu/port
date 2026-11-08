// Kept import-free so `scripts/checks` can load it under plain `node`, as with `stage-policy.ts`.

/** The opening of the plugin guard's allowlist-miss reason; `desktop-hosting` pins it against `guard-rules.mjs`. */
export const GUARD_ALLOWLIST_MISS_MARKER = "port: this command is not on the repository's allowlist"
