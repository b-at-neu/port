# Design Standards

Every stage agent working on interface work reads this document, because `docs.design` points at it: `plan-agent` designs UX states and copy against it, `impl-agent` builds to it, and `review-agent` cites it as a review dimension. It covers **`apps/desktop` only** — nothing else in this repository has an interface.

**Boundary with `ENGINEERING.md`.** `ENGINEERING.md` is how code is structured and what must be true of it. This document is what the interface looks like and the vocabulary for building it. **Accessibility requirements live in `ENGINEERING.md` §5 alone** and are not restated here; the contrast ratios each token pairing actually achieves are recorded in §1, as design vocabulary.

**Status: the renderer predates this document.** The current renderer builds its DOM by hand with one stylesheet per screen. It is being replaced by a React renderer built to this document, screen by screen. Until a screen is migrated, work inside it matches its surrounding code, and that is **not** a finding against this document. Every React screen, and every new screen, follows this document in full.

**Stack:** React · Tailwind · shadcn/ui (components added through its CLI, so their source is in the tree) · lucide icons · Inter and JetBrains Mono, bundled with the app so it works offline. Tokens are declared once, as CSS custom properties on shadcn's own role names, in the renderer's Tailwind theme stylesheet. That stylesheet is the only place a colour value appears.

**Identity.** The layout and spacing follow Claude Code's desktop app on purpose. The identity is port's own: blue accent, Inter, the sailboat mark (§8). The app must never look like an Anthropic product. No coral or cream palette, no Claude or Claude Code logo or wordmark, and never the name "Claude Code" for the app itself.

## 1. Tokens

### Colour roles

Components use roles, never values. Tailwind arbitrary colour values (`bg-[#…]`) and raw hex in components are not allowed.

| Role | Light | Dark | Used for |
| --- | --- | --- | --- |
| `background` | `#ffffff` | `#09090b` | Main area |
| `sidebar` | `#fafafa` | `#111113` | Sidebar, group headers in lists |
| `card` / `popover` | `#ffffff` | `#18181b` | Raised surfaces: composer, menus, dialogs |
| `muted` | `#f4f4f5` | `#1c1c1f` | Your messages in a conversation, inline code, idle pills, segmented-control selection |
| `accent` (hover/selected surface) | `#e4e4e7` | `#27272a` | Hovered and selected sidebar rows |
| `border` | `#e4e4e7` | `#27272a` | Every divider and outline |
| `foreground` | `#18181b` | `#fafafa` | Primary text |
| `foreground-secondary` | `#3f3f46` | `#d4d4d8` | Sidebar items, secondary labels |
| `muted-foreground` | `#71717a` | `#a1a1aa` | Metadata, ticket numbers, section labels, timestamps |
| `faint` | `#a1a1aa` | `#71717a` | **Non-text only**: idle dots, disabled glyphs, decorative strokes |
| `primary` | `#2563eb` | `#2563eb` | Primary button fill, the app icon |
| `primary-foreground` | `#ffffff` | `#ffffff` | Text on `primary` |
| `ring` | `#2563eb` | `#3b82f6` | Focus ring, selection outline, progress fill |
| `primary-soft` | `#dbeafe` | `#172554` | "Working" pill background, finished phase segments |
| `primary-text` | `#1d4ed8` | `#93c5fd` | Links, "working" pill text, row actions |
| `selection` | `#eff6ff` | `#0f1a33` | The selected row in a list |

### Status roles

Status colour is separate from the accent and means the same thing on every screen.

| Status | Means | Pill background / text (light) | Pill background / text (dark) | Dot (light / dark) |
| --- | --- | --- | --- | --- |
| `working` | Claude is doing something | `#dbeafe` / `#1d4ed8` | `#172554` / `#93c5fd` | `#2563eb` / `#3b82f6` |
| `attention` | **Needs you**, or draining | `#fef3c7` / `#92400e` | `#3b2506` / `#fcd34d` | `#d97706` / `#f59e0b` |
| `success` | Done, passing, running pipeline | `#dcfce7` / `#166534` | `#052e16` / `#86efac` | `#16a34a` / `#22c55e` |
| `danger` | Failed, conflict, red check | `#fee2e2` / `#991b1b` | `#3b0d0d` / `#fca5a5` | `#dc2626` / `#ef4444` |
| `idle` | Paused, queued, nothing happening | `muted` / `foreground-secondary` | `muted` / `foreground-secondary` | `faint` |

**Amber always means "needs you".** It is never decoration, and nothing that needs you is shown in any other colour.

**Diffs:** added lines `#f0fdf4` / `#166534` (dark `#06240f` / `#86efac`); removed lines `#fef2f2` / `#991b1b` (dark `#2a0b0b` / `#fca5a5`).

### Measured contrast

WCAG ratios for the pairings the interface uses. The requirement itself is in `ENGINEERING.md` §5.

| Pairing | Light | Dark |
| --- | --- | --- |
| `foreground` on `background` | 17.7 | 19.1 |
| `foreground-secondary` on `background` | 10.4 | 13.5 |
| `muted-foreground` on `background` / `sidebar` | 4.8 / 4.6 | 7.8 / 7.4 |
| `muted-foreground` on `muted` / `accent` | **4.4 / 3.8: fails** | 6.6 / 5.8 |
| `faint` on `background` | **2.6: fails** | **4.1: fails** |
| `primary-foreground` on `primary` | 5.2 | 5.2 |
| `primary-text` on `background` / `primary-soft` | 6.7 / 5.5 | 11.0 / 8.2 |
| Status pill text on its background | 6.4 – 6.8 | 8.9 – 10.6 |
| Diff text on its background | 6.8 / 7.6 | 11.8 / 9.6 |

Two rules follow from the failures:
- **Text on `muted` or `accent` surfaces uses `foreground` or `foreground-secondary`,** never `muted-foreground`.
- **`faint` is never used for text.**

The dark `primary` stays `#2563eb`, because white text on the lighter `#3b82f6` measures 3.7.

### Spacing, size and shape

| Token | Value | Used for |
| --- | --- | --- |
| Grid | 4px | Every margin, padding and gap is a multiple of 4 (2px allowed only inside pills and the phase bar) |
| Panel padding | 16px | Main area, detail pane |
| Screen header height | 44px | The bar at the top of each screen |
| List row height | 36px | Board, Backlog, Needs you |
| Group header height | 32px | "Waiting on you", "In progress", … |
| Sidebar row height | 28px (sessions under a repo: 26px) | Sidebar |
| Sidebar width | 248px, collapsible | — |
| Detail pane width | 290px | Right-hand pane |
| Conversation column | max 680px, centred | Session view |
| Control height | 26px small, 32px default | Buttons, inputs |
| Radius | 6px controls · 8px cards, popovers, dialogs, diffs · 10px the composer · full for pills | — |
| Elevation | Borders separate surfaces. Shadows only on popovers, menus and dialogs | — |

## 2. Typography

| Use | Family | Size | Weight |
| --- | --- | --- | --- |
| Body, list rows | Inter | 13px / line height 1.5 (conversation text 1.6) | 400 |
| Secondary text, buttons, tags | Inter | 12px | 400 / 500 |
| Metadata, section labels, pills | Inter | 11px | 500 |
| Panel and screen titles | Inter | 15px | 600 |
| Code, paths, commands, diffs, branch names | JetBrains Mono | 12px | 400 |

- Only weights 400, 500 and 600.
- Nothing below 11px.
- Counts, costs, durations and ticket numbers use tabular figures (`font-variant-numeric: tabular-nums`).
- Section labels are sentence case at 11px/500, not uppercase.

## 3. Layout

**Window:** native title bar on every platform. Three columns: the sidebar, the main area, and an optional detail pane. The app restores the last screen, selection and collapsed state on launch.

**Sidebar, top to bottom:**
1. **Mark and wordmark.**
2. **Screens:** Needs you (amber count), Board, Backlog, Repositories.
3. **Pipelines:** one row per registered repo. Each row has:
   - a caret that collapses it, with the state remembered;
   - the repo name;
   - its run-state `StatusPill` menu (§4).

   The repo's live stage sessions are nested under it, labelled `#N <phase>`. A collapsed repo with a session that needs you shows an amber dot next to its name.
4. **Your sessions:** your own live sessions, **New session**, and **History…**.
5. **Footer:** Settings, plus one status dot for the `claude` CLI and `gh`, red when either is missing or signed out.

**Screens in the first release:**

| Screen | Content |
| --- | --- |
| Needs you | Everything waiting on the operator, newest first, each with its action inline: plan reviews, PRs ready to merge, questions from stage sessions, needs-human escalations, blocked items |
| Board | Grouped list: **Waiting on you**, **In progress**, **Queued**. Toggle grouping by phase or by repo, plus a repo filter. **Work on ticket** in the header |
| Backlog | Open tickets not yet in a pipeline, with **Work on**: interactive plan review or auto-plan |
| Repositories | One page per repo, with tabs: Overview (health, label resolution, overrides in effect), Worktrees, Denials |
| Session | Conversation and composer. **Changes** opens the session's diff in the detail pane |
| History | Past sessions and transcripts, with search |
| Settings | Theme, CLI and `gh` status, default model and permission mode |

Scoping epics, releases and analytics are out of scope for the first release.

**Detail pane rule.** Selecting an item in a list (a ticket, worktree or denial) opens it in the right-hand pane instead of navigating away. Esc closes it. Full-page navigation is only for screens and sessions.

**Board row anatomy, left to right:**
- ticket number (`muted-foreground`, tabular);
- title (truncates);
- repo tag;
- `PhaseBar`;
- phase pill;
- the one next action as a link ("Review plan", "Open PR", "Refresh").

**Conversation:** document flow, not chat bubbles.
- **Your messages:** `muted` blocks.
- **Claude's text:** full width, rendered markdown.
- **Each tool call:** a one-line `ToolCallRow` (icon, verb, mono path or command, result summary) that expands. Edits show their diff inline.
- **Composer controls**, below the input: model, permission mode, effort, `ContextMeter`, send.

**Keyboard:**

| Keys | Action |
| --- | --- |
| Ctrl/Cmd+K | Command palette |
| Ctrl/Cmd+N | New session |
| Ctrl/Cmd+1…9 | Jump to session |
| Ctrl/Cmd+Tab | Next session |
| Ctrl/Cmd+B | Toggle sidebar |
| F2 | Rename session |
| Enter / Shift+Enter | Send / new line in the composer |
| Esc | Stop Claude's turn when the composer is focused; otherwise close the pane or dialog |
| J / K, then Enter | Move through Board and Backlog rows, open the selected one |

## 4. Component treatments

**shadcn primitives.** Use them as shipped and change them only through variants:
- Button: `default` (primary), `secondary`, `outline`, `ghost`, `destructive`; sizes small and default.
- DropdownMenu, ContextMenu, Command, Dialog, AlertDialog, Popover, Tooltip.
- Tabs, Input, Textarea, Select, Checkbox, ScrollArea, Separator, Skeleton, Collapsible, Sonner toasts.
- Switch, only on the Settings screen.

**port components.** These live in one shared components folder; a screen never builds its own version.

| Component | Treatment |
| --- | --- |
| `StatusPill` | Dot, then label, using the status roles. With a menu it shows a chevron: the repo run state is `● Running ▾` with Run, Pause and Drain, each with a one-line hint ("finish in-flight") |
| `PhaseBar` | Six 10×4px segments with a 2px gap, for plan, plan review, implement, review, revision, merge. Finished segments `primary-soft`, the current one `primary`, waiting-on-you `attention`, complete `success`, the rest `accent`. Tooltip names the phase |
| `PhaseList` | Vertical version for the detail pane: an 8px dot per phase, with who and when ("Plan approved by you · 2h ago") and live cost and time on the current phase |
| `TicketRow`, `RepoPipelineRow`, `SessionRow`, `NeedsYouItem` | The list rows (§3) |
| `ToolCallRow`, `DiffView`, `Markdown`, `Composer`, `ContextMeter` | Session pieces. `ContextMeter` is a 56×4px bar plus a percentage |
| `DetailPane`, `EmptyState`, `ErrorBanner` | Layout and states |

**If a pattern appears twice, it becomes a shared component.** One-off styling inside a screen file is a finding.

**Every interactive element has hover, focus, active and disabled states.**
- Hover: `accent` surface.
- Focus: a 2px `ring` outline offset by 2px.
- Disabled: `faint` glyphs at 50% opacity, with a tooltip saying why.

**Every data region renders all four states:**
- **Loading:** `Skeleton` rows shaped like the real content. A spinner appears only inside a button whose action is running.
- **Empty:** `EmptyState`, which is an icon, one sentence, and the single useful action.
- **Error:** an `ErrorBanner` inside the affected region, saying what failed and how to fix it. A read failure never opens a dialog.
- **Stale:** when a source stops refreshing, the screen header shows "Updated 3m ago" in `attention`.

**Actions:**
- **Reversible actions apply immediately with a toast:** run, pause, drain, retry. The toast offers Undo where possible.
- **Actions with consequences open an `AlertDialog`:** stopping a session, clearing needs-human, sending an approved PR back, removing a worktree. The dialog states the consequence, and its confirm button names the action ("Stop session", never "OK").
- **A running action shows its pending state on its own button.** A failure produces a toast with the reason. Nothing retries on its own, and nothing offers to overwrite a conflicting write.

## 5. Motion and feedback

- Popovers, menus, the detail pane and dialogs enter and leave with a 150ms ease-out fade and a 4px slide.
- The only continuous animation is a soft 2s pulse on the dot of something that needs you.
- Streaming text appears as it arrives, with no typing effect.
- Under the OS reduce-motion setting, every transition is instant and the pulse stops.

## 6. Copy and tone

- Plain, short and factual: say what happened and what to do next.
- Sentence case everywhere.
- No exclamation marks, no "Oops", no exaggeration.
- Buttons are verbs naming their result: "Approve plan", "Stop session", "Open PR", "Work on ticket".

**Names:**
- The app is **port**, always lowercase.
- Claude is **Claude**.
- GitHub issues are **tickets** and pull requests are **PRs**.
- Another repo's ticket is `#300` plus a repo tag.
- About: "Powered by Claude", and "port runs your own installed Claude Code under your own account."

**Phase display names come from the label role, never the label string,** so a repository that renames its labels still reads the same. A raw label name appears only on a repo's Overview tab.

| Role (`labels.*`) | Display name |
| --- | --- |
| `ready` | Queued |
| `planning` | Planning |
| `planReview` | Plan review |
| `planChangesRequested` | Replanning |
| `planApproved` | Plan approved |
| `inProgress` | Implementing |
| `prOpened` | Not shown. The issue's phase is read from its pull request from here on |
| `readyForReview` | Waiting for review |
| `reviewing` | Reviewing |
| `needsRevision` | Needs revision |
| `revising` | Revising |
| `approved` | Ready to merge |
| `needsHuman` | Needs you |
| `blocked` | Blocked |
| `refreshBranch` / `refreshing` | Refreshing |

The markers `marker` and `autoPlan` are never shown as phases; `autoPlan` appears as an "Auto-plan" tag on the row. **Paused** is not a label role. It is shown when the app reports an item as paused, using the `idle` status.

**Formats:**
- Durations: `12m`, `1h 4m`.
- Relative time: `2h ago`, with the exact time in a tooltip.
- Cost: `$0.92`.
- Context: `42%`.

**A message that needs the operator leads with the action:**
- "Review the plan for #305"
- "#24 is asking: which hero layout?"
- "#312 can't be reviewed: its branch conflicts with the base branch. Refresh it."

**Errors name the fix:** "gh is signed out. Run `gh auth login`."

## 7. Agent quick reference

- [ ] Legacy (hand-built DOM) screen? Match the surrounding code and stop here. React screen? Everything below applies.
- [ ] Colour only through the §1 roles. No hex, no Tailwind arbitrary colours, no new role without changing this document.
- [ ] Status colour follows §1's status table. Anything waiting on the operator is `attention`, and nothing else is.
- [ ] No `muted-foreground` text on `muted`/`accent` surfaces, and no `faint` text anywhere.
- [ ] Sizes from §1 and §2 only: 4px grid, 36px rows, 44px headers, 13/12/11/15px type, weights 400/500/600, tabular figures for numbers.
- [ ] shadcn primitives first, then the shared port components in §4. A pattern used twice becomes a shared component.
- [ ] lucide icons only: 16px in the interface, 14px inline in text, one stroke width.
- [ ] Every data region has loading, empty, error and stale states (§4).
- [ ] Reversible actions toast; consequential ones confirm with a named-action `AlertDialog`.
- [ ] Phase names come from the role map in §6, never a label string.
- [ ] Copy is sentence case, verb-first buttons, no exclamation marks; messages that need the operator lead with the action.
- [ ] Screenshots of the screen in light and dark are attached to the pull request.

## 8. The mark

port's mark is a minimal outline sailboat. The sail is one closed shape, joined to the hull only by a short stretch of mast, so its foot floats above the deck.

- **`docs/design/port-mark.svg`** is the canonical mark: a 24×24 view box, stroke-width 2.2, round caps and joins, drawn in `currentColor`. In the sidebar it sits in a 20px `primary` rounded square (5px radius), white, at 70% of the square.
- **`docs/design/port-app-icon.svg`** is the canonical app icon: a 1024px `primary` square with a 230px corner radius, and the mark in white filling 70% of it. Platform icon files are generated from this file and never edited by hand.
- **Don't** outline-fill the mark, recolour it outside `primary`/`primary-foreground`/`currentColor`, add a wave or scenery to it, or set it next to any Anthropic mark.
