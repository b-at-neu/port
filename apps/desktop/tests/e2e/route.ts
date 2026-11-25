// The E2E build's route: every command and every GitHub request goes to the fake, never to a host binary or the network.
import { isAbsolute } from 'node:path'
import { toConditionalResult, toResult, type Exchange } from '@/main/platform/github-wire'
import type { CommandResult, PlatformRoute } from '@/types/platform'

function fromFake(result: CommandResult): Exchange {
  if (!result.ok) {
    if (result.kind !== 'nonzero') return result
    return { ok: false, kind: 'unknown', status: null, body: '', message: result.stderr.trim() }
  }
  try {
    const reply = JSON.parse(result.stdout) as { status: number; headers: Record<string, string>; body: string }
    return { ok: true, status: reply.status, headers: reply.headers, body: reply.body }
  } catch {
    return { ok: false, kind: 'unknown', status: null, body: '', message: "the e2e fake's reply wasn't JSON" }
  }
}

export const resolveCommand: PlatformRoute['resolveCommand'] = (command, args, options) => {
  const fake = process.env['PORT_E2E_FAKE']
  if (fake === undefined || !isAbsolute(fake)) return Promise.resolve({ ok: false, kind: 'spawn-failed', message: 'PORT_E2E_FAKE must be set to an absolute path' })
  return Promise.resolve({ ok: true, path: process.execPath, args: [fake, command, ...args], env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' } })
}

export const githubClient: PlatformRoute['githubClient'] = (_real, run) => {
  const send = async (request: unknown): Promise<Exchange> => fromFake(await run('gh', ['e2e-http', JSON.stringify(request)]))
  return {
    request: async (request) => {
      const reply = await send(request)
      return reply.ok ? toResult(reply.status, reply.headers, reply.body) : reply
    },
    conditional: async (request) => toConditionalResult(await send(request), request.ifNoneMatch !== undefined),
    public: async (request) => {
      const reply = await send(request)
      return reply.ok ? toResult(reply.status, reply.headers, reply.body) : reply
    },
  }
}
