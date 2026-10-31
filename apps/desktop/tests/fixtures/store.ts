import type { HostedStore } from '@/types/hosting'

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`${name} should not be invoked in this case`)
  }
}

export function storeStub(overrides: Partial<HostedStore> = {}): HostedStore {
  return {
    start: unexpected('start'),
    send: unexpected('send'),
    interrupt: unexpected('interrupt'),
    close: unexpected('close'),
    attach: unexpected('attach'),
    list: unexpected('list'),
    closeAll: unexpected('closeAll'),
    answerPermission: unexpected('answerPermission'),
    invoke: unexpected('invoke'),
    setControls: unexpected('setControls'),
    answerQuestion: unexpected('answerQuestion'),
    answerPlan: unexpected('answerPlan'),
    dismiss: unexpected('dismiss'),
    snapshotOf: unexpected('snapshotOf'),
    cwdOf: unexpected('cwdOf'),
    capacity: unexpected('capacity'),
    setLimit: unexpected('setLimit'),
    defaults: unexpected('defaults'),
    setDefaults: unexpected('setDefaults'),
    rename: unexpected('rename'),
    restorable: unexpected('restorable'),
    restore: unexpected('restore'),
    discardRestorable: unexpected('discardRestorable'),
    marks: unexpected('marks'),
    setMark: unexpected('setMark'),
    stopTask: unexpected('stopTask'),
    ...overrides,
  }
}

// The benign defaults the dispatch tests' local `fakeStore` relies on.
export const DISPATCH_STORE_DEFAULTS: Partial<HostedStore> = {
  send: () => ({ ok: true as const, uuid: 'u1', queued: true }),
  close: () => Promise.resolve({ ok: true }),
  list: () => [],
  closeAll: () => Promise.resolve(),
  snapshotOf: () => null,
  cwdOf: () => null,
  capacity: () => Promise.resolve({ limit: 4, ceiling: 8 }),
  restorable: () => Promise.resolve([]),
  discardRestorable: () => Promise.resolve({ ok: true }),
  setControls: () => Promise.resolve({ ok: false, kind: 'unknown-session' }),
  answerQuestion: () => ({ ok: false, kind: 'unknown-session' }),
  answerPlan: () => ({ ok: false, kind: 'unknown-session' }),
}
