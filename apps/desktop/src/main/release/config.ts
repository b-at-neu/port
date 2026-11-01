// The `release` block of `.claude/port.config.json` at the default ref — a violated path falls back to its default, an unreadable file fails the read.
import { CONFIG_DEFAULTS, validateConfig } from '@/main/registry/schema'
import type { RefReader } from '@/types/registry'
import type { ReleaseConfigRead } from '@/types/release'

const CONFIG_PATH = '.claude/port.config.json'

interface LooseRelease {
  readonly versionSource?: unknown
  readonly versionFiles?: unknown
  readonly versionCommand?: unknown
  readonly postPublishHook?: unknown
}

function releaseBlockOf(value: unknown): LooseRelease {
  const block = typeof value === 'object' && value !== null ? (value as { release?: unknown }).release : undefined
  return typeof block === 'object' && block !== null ? block : {}
}

function isViolated(violated: ReadonlySet<string>, path: string): boolean {
  return [...violated].some((candidate) => candidate === path || candidate.startsWith(`${path}/`) || candidate === '/release')
}

function pick<T>(raw: unknown, path: string, violated: ReadonlySet<string>, fallback: T): T {
  return isViolated(violated, path) || raw === undefined ? fallback : (raw as T)
}

export async function readReleaseConfig(read: RefReader): Promise<ReleaseConfigRead> {
  const file = await read(CONFIG_PATH)
  if (!file.ok) return { ok: false, message: `Couldn't read ${CONFIG_PATH}: ${file.message}` }

  let value: unknown
  try {
    value = JSON.parse(file.text)
  } catch (error) {
    return { ok: false, message: `${CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }

  const violated = new Set(validateConfig(value).violations.map((violation) => violation.path))
  const block = releaseBlockOf(value)
  const defaults = CONFIG_DEFAULTS.release
  const source = pick<unknown>(block.versionSource, '/release/versionSource', violated, defaults.versionSource)
  return {
    ok: true,
    config: {
      versionSource: source === 'package' ? 'package' : 'tags',
      versionFiles: pick(block.versionFiles, '/release/versionFiles', violated, defaults.versionFiles),
      versionCommand: pick(block.versionCommand, '/release/versionCommand', violated, defaults.versionCommand),
      postPublishHook: pick(block.postPublishHook, '/release/postPublishHook', violated, defaults.postPublishHook),
    },
  }
}
