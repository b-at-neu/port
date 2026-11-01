// Pure phase resolution — the order mirrors the release skill's "Resolve the version" and "State detection".
import type { PhaseInput, PullLink, ReleasePhase, ReleasePrInput } from '@/types/release'
import { releaseTag, versionOfBumpBranch, versionOfReleaseTitle } from '@/utils/release/format'
import { normalizeVersion, parseVersion, stripPrerelease } from '@/utils/release/version'

function linkOf(pr: ReleasePrInput): PullLink {
  return { number: pr.number, url: pr.url }
}

function guardOf(input: PhaseInput): ReleasePhase | null {
  if (!input.moduleEnabled) return { kind: 'off' }
  if (input.production === null) return { kind: 'single-branch' }
  if (input.versionSource === 'package' && input.versionFiles.length === 0) return { kind: 'misconfigured' }
  if (input.versionCommand !== null) return { kind: 'needs-terminal' }
  return null
}

function titleVersion(pr: ReleasePrInput): string | null {
  const raw = versionOfReleaseTitle(pr.title)
  return raw === null ? null : normalizeVersion(raw)
}

function cleanVersion(text: string | null): string | null {
  if (text === null) return null
  const parsed = parseVersion(text)
  return parsed !== null && parsed.prerelease === null ? normalizeVersion(text) : null
}

/** The first matching case wins, so a half-finished release resumes from wherever it stopped. */
export function resolvePhase(input: PhaseInput): ReleasePhase {
  const guard = guardOf(input)
  if (guard !== null) return guard

  if (input.bumpBranches.length > 1) return { kind: 'conflict', branches: input.bumpBranches.map((branch) => branch.name) }
  const bump = input.bumpBranches[0]
  if (bump !== undefined) {
    const version = normalizeVersion(versionOfBumpBranch(bump.name) ?? '')
    if (version !== null) return { kind: 'waiting-bump', version, bumpPr: bump.pr, releasePr: input.openReleasePr === null ? null : linkOf(input.openReleasePr) }
  }

  if (input.openReleasePr !== null) {
    const fallback = input.integrationVersion === null ? null : stripPrerelease(input.integrationVersion)
    return { kind: 'waiting-merge', version: titleVersion(input.openReleasePr) ?? fallback, releasePr: linkOf(input.openReleasePr) }
  }

  const closed = input.lastClosedReleasePr
  const closedVersion = closed === null ? null : titleVersion(closed)
  if (closed !== null && closed.merged && closedVersion !== null && !input.publishedTags.has(releaseTag(closedVersion))) {
    return { kind: 'ready-to-publish', version: closedVersion }
  }
  const productionVersion = input.versionSource === 'package' ? cleanVersion(input.productionVersion) : null
  if (productionVersion !== null && !input.publishedTags.has(releaseTag(productionVersion))) {
    return { kind: 'ready-to-publish', version: productionVersion }
  }

  if (closed !== null && !closed.merged && closedVersion !== null && !input.publishedTags.has(releaseTag(closedVersion))) {
    return { kind: 'abandoned', version: closedVersion, releasePr: linkOf(closed) }
  }

  if (input.versionSource === 'package') {
    const integration = cleanVersion(input.integrationVersion)
    if (integration !== null && integration !== cleanVersion(input.productionVersion)) return { kind: 'bumped', version: integration }
  }

  return { kind: input.gatherEmpty ? 'nothing-to-release' : 'idle' }
}
