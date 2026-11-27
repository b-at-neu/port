import type { Tracker } from '@/main/github/tracker'
import type { Platform } from '@/main/platform'

export type TrackerContext = { readonly tracker: Tracker }

export type GitHubReadContext = Pick<Platform, 'githubHttp' | 'clock'>

export type GitHubConditionalContext = Pick<Platform, 'githubConditional' | 'clock'>

export type GitHubPublicContext = Pick<Platform, 'githubPublic'>

export type GitHubWriteContext = Pick<Platform, 'ghWrite' | 'git' | 'clock'>

export type GitHubTrackerContext = GitHubReadContext & GitHubConditionalContext & GitHubWriteContext

export type LedgerWriteContext = Pick<Platform, 'ghWrite' | 'fs'>
