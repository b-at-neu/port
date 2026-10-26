// The one place a version and a build commit become display text — every version surface renders this, never its own concatenation.

/** `'<version> · <commit>'` only for a prerelease `version` with a non-empty `commit`; `version` unchanged otherwise. */
export function formatAppVersion(version: string, commit: string | null): string {
  if (/^\d+\.\d+\.\d+-/.test(version) && commit !== null && commit.length > 0) {
    return `${version} · ${commit}`
  }
  return version
}
