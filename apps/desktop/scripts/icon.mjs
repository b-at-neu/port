// Renders docs/design/port-app-icon.svg (DESIGN §8: platform icons are
// generated, never hand-edited) to build/icon.png at 1024px wide, the size
// electron-builder's own icon pipeline derives every platform icon from
// (.icns on macOS, .ico on Windows, straight through on Linux).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const here = import.meta.dirname
const svgPath = join(here, '../../../docs/design/port-app-icon.svg')
const buildDir = join(here, '../build')
const iconPath = join(buildDir, 'icon.png')

const svg = readFileSync(svgPath, 'utf8')
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } })
const png = resvg.render().asPng()

mkdirSync(buildDir, { recursive: true })
writeFileSync(iconPath, png)

console.log(`[icon] wrote ${png.length} bytes to build/icon.png`)
