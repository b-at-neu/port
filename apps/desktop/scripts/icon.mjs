// Renders docs/design/port-app-icon.svg (DESIGN §8: platform icons are
// generated, never hand-edited) to build/icon.png at 1024px wide — the size
// electron-builder's own icon pipeline derives the macOS .icns and Windows
// .ico from. Linux doesn't use that pipeline: electron-builder installs
// `linux.icon` verbatim into hicolor's `<size>x<size>/apps/`, and the
// system's hicolor theme only declares sizes up to 512x512 (see
// /usr/share/icons/hicolor/index.theme) — a single 1024px file lands in a
// directory GTK's icon-theme lookup never scans, so the launcher and window
// icon silently fall back to generic, regardless of any app-id/WM_CLASS
// fix. So Linux also gets a `build/icons/<size>x<size>.png` set at every
// size hicolor actually declares.
//
// The source art is a full-bleed rounded square (DESIGN §8 — no transparent
// margin), which is correct for macOS/Windows: both auto-mask/inset
// third-party icons themselves, so they expect edge-to-edge art. GNOME does
// no such inset, so the same full-bleed render sits visibly larger than
// neighboring icons that do ship their own padding. The Linux set is
// rendered from a copy scaled down and centered on a transparent canvas to
// match.
//
// Also renders a 64px favicon for the renderer, so dev runs and the browser
// tab both show the real icon, not Electron's/the browser's default.
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
