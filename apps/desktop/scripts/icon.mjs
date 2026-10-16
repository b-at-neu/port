// Renders docs/design/port-app-icon.svg (DESIGN §8: platform icons are
// generated, never hand-edited) to build/icon.png at 1024px wide, the size
// electron-builder's own icon pipeline derives every platform icon from
// (.icns on macOS, .ico on Windows, straight through on Linux). Also renders
// a 64px favicon for the renderer, so dev runs and the browser tab both show
// the real icon, not Electron's/the browser's default.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const here = import.meta.dirname
const svgPath = join(here, '../../../docs/design/port-app-icon.svg')
const buildDir = join(here, '../build')
const iconPath = join(buildDir, 'icon.png')
const faviconDir = join(here, '../src/renderer/public')
const faviconPath = join(faviconDir, 'favicon.png')

const svg = readFileSync(svgPath, 'utf8')

const icon = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng()
mkdirSync(buildDir, { recursive: true })
writeFileSync(iconPath, icon)
console.log(`[icon] wrote ${icon.length} bytes to build/icon.png`)

const favicon = new Resvg(svg, { fitTo: { mode: 'width', value: 64 } }).render().asPng()
mkdirSync(faviconDir, { recursive: true })
writeFileSync(faviconPath, favicon)
console.log(`[icon] wrote ${favicon.length} bytes to src/renderer/public/favicon.png`)
