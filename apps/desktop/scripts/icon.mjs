// Renders docs/design/port-app-icon.svg (DESIGN §8) to build/icon.png, a
// padded Linux icon set at every hicolor size, and a renderer favicon.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const here = import.meta.dirname
const svgPath = join(here, '../../../docs/design/port-app-icon.svg')
const buildDir = join(here, '../build')
const iconPath = join(buildDir, 'icon.png')
const iconsDir = join(buildDir, 'icons')
const faviconDir = join(here, '../src/renderer/public')
const faviconPath = join(faviconDir, 'favicon.png')

// Every size hicolor's own index.theme declares under */apps.
const linuxIconSizes = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512]

const svg = readFileSync(svgPath, 'utf8')

// Nests the full-bleed art inside a transparent canvas of the same nominal size, scaled down
// and centered — the same x/y/width/height inset technique the source SVG already uses to
// place its glyph inside the background rect.
const LINUX_CONTENT_SCALE = 0.88
const inset = (1024 * (1 - LINUX_CONTENT_SCALE)) / 2
const content = 1024 * LINUX_CONTENT_SCALE
const linuxSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><svg x="${inset}" y="${inset}" width="${content}" height="${content}">${svg}</svg></svg>`

const icon = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng()
mkdirSync(buildDir, { recursive: true })
writeFileSync(iconPath, icon)
console.log(`[icon] wrote ${icon.length} bytes to build/icon.png`)

mkdirSync(iconsDir, { recursive: true })
for (const size of linuxIconSizes) {
  const sized = new Resvg(linuxSvg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(join(iconsDir, `${size}x${size}.png`), sized)
}
console.log(`[icon] wrote ${linuxIconSizes.length} sizes to build/icons/`)

const favicon = new Resvg(svg, { fitTo: { mode: 'width', value: 64 } }).render().asPng()
mkdirSync(faviconDir, { recursive: true })
writeFileSync(faviconPath, favicon)
console.log(`[icon] wrote ${favicon.length} bytes to src/renderer/public/favicon.png`)
