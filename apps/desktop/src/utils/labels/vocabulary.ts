/** `'CLAUDE.md'` is an override from the repository's own `port-overrides` block; it wins over `'config'`, which wins over `'default'`. */
export type LabelSource = 'config' | 'default' | 'CLAUDE.md'

/** A config-authoring mistake, never a thrown error. */
export type VocabularyProblem =
  | { readonly kind: 'unknown-key'; readonly key: string }
  | { readonly kind: 'invalid-override'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'collision'; readonly name: string; readonly keys: readonly string[] }
  | { readonly kind: 'case-mismatch'; readonly key: string; readonly resolved: string; readonly actual: string }

/** The part of a vocabulary verification reads: any vocabulary that names its labels. */
export interface VerifiableVocabulary {
  readonly labels: readonly { readonly key: string; readonly name: string }[]
  readonly problems: readonly VocabularyProblem[]
}

/** A fetch that failed is a distinct value, never an empty array — "no labels came back" and "the repository has no labels" must not collapse into one state. */
export type RepoLabels = { readonly ok: true; readonly names: readonly string[] } | { readonly ok: false; readonly reason: string }

export type VocabularyVerdict = 'verified' | 'partial' | 'mis-resolved' | 'unverified'

export interface VocabularyReport {
  readonly verdict: VocabularyVerdict
  readonly present: readonly string[]
  readonly missing: readonly string[]
  readonly problems: readonly VocabularyProblem[]
  readonly repoLabels: RepoLabels
  readonly unverifiedReason?: string
}

/** Compares names with `toLowerCase()`, not `toLocaleLowerCase` (which maps dotted/dotless `I` under a Turkish locale), since GitHub matches case-insensitively. */
export function verifyVocabulary(vocabulary: VerifiableVocabulary, repoLabels: RepoLabels): VocabularyReport {
  if (!repoLabels.ok) {
    return {
      verdict: 'unverified',
      present: [],
      missing: [],
      problems: vocabulary.problems,
      repoLabels,
      unverifiedReason: repoLabels.reason,
    }
  }

  const actualByLower = new Map<string, string>()
  for (const name of repoLabels.names) {
    actualByLower.set(name.toLowerCase(), name)
  }

  const present: string[] = []
  const missing: string[] = []
  const problems: VocabularyProblem[] = [...vocabulary.problems]

  for (const label of vocabulary.labels) {
    const actual = actualByLower.get(label.name.toLowerCase())
    if (actual === undefined) {
      missing.push(label.name)
      continue
    }
    present.push(label.name)
    if (actual !== label.name) {
      problems.push({ kind: 'case-mismatch', key: label.key, resolved: label.name, actual })
    }
  }

  const verdict: VocabularyVerdict =
    missing.length === 0 ? 'verified' : present.length === 0 && vocabulary.labels.length > 0 ? 'mis-resolved' : 'partial'

  return { verdict, present, missing, problems, repoLabels }
}
