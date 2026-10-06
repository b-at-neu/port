// The About notice (#337) — read by both the About screen and the native
// About panel (`main/index.ts`), and pinned against DESIGN.md §6's `About:`
// line and `NOTICE.txt` by `scripts/checks/desktop-packaging.ts`. Renderer-
// safe: no Node import, so it compiles under `tsconfig.web.json` too.
export const ABOUT_POWERED_BY = 'Powered by Claude'
export const ABOUT_NOTICE = 'port runs your own installed Claude Code under your own account.'
