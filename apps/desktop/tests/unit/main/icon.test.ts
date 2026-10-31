import { describe, expect, it } from 'vitest'
import { devDockIconPath, windowIconPath } from '@/main/icon'
import { join } from 'node:path'

const base = { mainDir: '/app/out/main', resourcesPath: '/app/resources' }

describe('windowIconPath', () => {
  it('is null on darwin, packaged or not', () => {
    expect(windowIconPath({ ...base, platform: 'darwin', isPackaged: false })).toBeNull()
    expect(windowIconPath({ ...base, platform: 'darwin', isPackaged: true })).toBeNull()
  })

  it('reads the build icon when unpackaged, on linux or win32', () => {
    expect(windowIconPath({ ...base, platform: 'linux', isPackaged: false })).toBe(join('/app/out/main', '../../build/icon.png'))
    expect(windowIconPath({ ...base, platform: 'win32', isPackaged: false })).toBe(join('/app/out/main', '../../build/icon.png'))
  })

  it('is null when packaged on win32 (the exe carries its own icon)', () => {
    expect(windowIconPath({ ...base, platform: 'win32', isPackaged: true })).toBeNull()
  })

  it('reads the extra-resource icon when packaged on linux', () => {
    expect(windowIconPath({ ...base, platform: 'linux', isPackaged: true })).toBe(join('/app/resources', 'icon.png'))
  })
})

describe('devDockIconPath', () => {
  it('is the build icon only for darwin dev', () => {
    expect(devDockIconPath({ ...base, platform: 'darwin', isPackaged: false })).toBe(join('/app/out/main', '../../build/icon.png'))
  })

  it('is null for packaged darwin', () => {
    expect(devDockIconPath({ ...base, platform: 'darwin', isPackaged: true })).toBeNull()
  })

  it('is null for any non-darwin platform', () => {
    expect(devDockIconPath({ ...base, platform: 'linux', isPackaged: false })).toBeNull()
    expect(devDockIconPath({ ...base, platform: 'win32', isPackaged: false })).toBeNull()
  })
})
