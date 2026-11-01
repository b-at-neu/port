// The literals `plugins/port/skills/release/SKILL.md` also uses, pinned against it by the `desktop-release` check.
export const RELEASE_LITERALS = {
  prTitle: 'Release v<version>',
  bumpBranch: 'bump/v<version>',
  bumpSubject: 'bump version to v<version>',
  notesFooter: '- Minor enhancements and bug fixes',
} as const

const VERSION_SLOT = '<version>'

function fill(template: string, version: string): string {
  return template.replace(VERSION_SLOT, version)
}

function slotPattern(template: string): RegExp {
  const [head = '', tail = ''] = template.split(VERSION_SLOT)
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`^${escape(head)}(\\S+)${escape(tail)}$`)
}

const PR_TITLE_PATTERN = slotPattern(RELEASE_LITERALS.prTitle)
const BUMP_BRANCH_PATTERN = slotPattern(RELEASE_LITERALS.bumpBranch)

export function releasePrTitle(version: string): string {
  return fill(RELEASE_LITERALS.prTitle, version)
}

export function bumpBranchName(version: string): string {
  return fill(RELEASE_LITERALS.bumpBranch, version)
}

export function bumpSubject(version: string): string {
  return fill(RELEASE_LITERALS.bumpSubject, version)
}

export function releaseTag(version: string): string {
  return `v${version}`
}

/** The raw version text of a `Release v<version>` title, or `null` for a renamed one. */
export function versionOfReleaseTitle(title: string): string | null {
  return PR_TITLE_PATTERN.exec(title.trim())?.[1] ?? null
}

/** The raw version text of a `bump/v<version>` branch name. */
export function versionOfBumpBranch(branch: string): string | null {
  return BUMP_BRANCH_PATTERN.exec(branch)?.[1] ?? null
}

export const BUMP_BRANCH_PREFIX = RELEASE_LITERALS.bumpBranch.replace(VERSION_SLOT, '')
