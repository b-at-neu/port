import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

const THEME_REL = 'apps/desktop/src/renderer/styles/theme.css';
const TEXT_CONTRAST = 4.5;
const DOT_CONTRAST = 3.0;
const BRAND_BORDER_CONTRAST = 3.0;

const bare = (hex: string): string => hex.replace(/^#/, '').toLowerCase();
const channel = (hex: string, from: number): number => parseInt(bare(hex).slice(from, from + 2), 16) / 255;

function luminance(hex: string): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(channel(hex, 0)) + 0.7152 * lin(channel(hex, 2)) + 0.0722 * lin(channel(hex, 4));
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `--name: value` declared in one theme's `:root` block, comments stripped. */
function themeBlock(css: string, theme: 'light' | 'dark'): Map<string, string> {
  const block = new RegExp(`:root\\[data-theme='${theme}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
  return new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The hex a custom property resolves to, following `var()` aliases inside the same theme block. */
function resolved(block: Map<string, string>, name: string, depth = 0): string | null {
  const value = block.get(name);
  if (value === undefined || depth > 8) return null;
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  if (alias) return resolved(block, alias[1], depth + 1);
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

// WCAG contrast of the phase pills, dots and brand surfaces in both themes — the one accessibility property of the palette a type or a unit test cannot see.
export default async function ({ expect, fail, ok }: Reporter) {
  expect(Math.abs(contrast('ffffff', '000000') - 21) < 0.01, 'phase-palette', 'contrast(white, black) is not 21 — the WCAG formula is broken');

  const css = readFileSync(join(root, THEME_REL), 'utf8');
  const themes = { light: themeBlock(css, 'light'), dark: themeBlock(css, 'dark') };
  const palettes = [...themes.light.keys()].flatMap((k) => /^phase-(.+)-pill$/.exec(k)?.[1] ?? []);
  expect(palettes.length > 0, 'phase-palette', `${THEME_REL} declares no --phase-*-pill property in its light theme`);

  // --- pill text 4.5:1 on its pill, every dot 3:1 on the background, the sidebar and the selected row, in both themes ---
  {
    let bad = false;
    for (const theme of ['light', 'dark'] as const) {
      const block = themes[theme];
      const [background, sidebar, selection] = [resolved(block, 'background'), resolved(block, 'sidebar'), resolved(block, 'selection')];
      for (const palette of palettes) {
        const pill = resolved(block, `phase-${palette}-pill`);
        const text = resolved(block, `phase-${palette}-pill-foreground`);
        const dot = resolved(block, `phase-${palette}-dot`);
        if (pill === null || text === null || dot === null || background === null || sidebar === null || selection === null) {
          bad = true;
          fail('phase-palette', `palette '${palette}' has an unresolvable colour in the ${theme} theme of ${THEME_REL} — every --phase-${palette}-* must resolve to a hex`);
          continue;
        }
        if (contrast(text, pill) < TEXT_CONTRAST) {
          bad = true;
          fail('phase-palette', `palette '${palette}' pill text ${text} on ${pill} is ${contrast(text, pill).toFixed(2)}:1 in the ${theme} theme, below ${TEXT_CONTRAST} — darken the text or lighten the pill`);
        }
        for (const [against, name] of [[background, 'background'], [sidebar, 'sidebar'], [selection, 'selection']] as const) {
          if (contrast(dot, against) < DOT_CONTRAST) {
            bad = true;
            fail('phase-palette', `palette '${palette}' dot ${dot} on ${name} (${against}) is ${contrast(dot, against).toFixed(2)}:1 in the ${theme} theme, below ${DOT_CONTRAST} — darken the light dot or lighten the dark one`);
          }
        }
      }
    }
    if (!bad) ok();
  }

  // --- text on the brand-tinted surfaces reaches 4.5:1, and the dark brand tile border 3:1 on the sidebar ---
  {
    let bad = false;
    const pairs: [string, string][] = [['foreground-secondary', 'accent'], ['primary-text', 'accent'], ['primary-text', 'selection'], ['primary-foreground', 'primary']];
    for (const theme of ['light', 'dark'] as const) {
      for (const [text, surface] of pairs) {
        const [fg, bg] = [resolved(themes[theme], text), resolved(themes[theme], surface)];
        if (fg === null || bg === null || contrast(fg, bg) < TEXT_CONTRAST) {
          bad = true;
          fail('phase-palette', `${theme} --${text} (${fg ?? 'unresolved'}) on --${surface} (${bg ?? 'unresolved'}) is ${fg !== null && bg !== null ? contrast(fg, bg).toFixed(2) : 'unmeasurable'}:1, below ${TEXT_CONTRAST} — adjust --${text}`);
        }
      }
    }
    const [border, sidebar] = [resolved(themes.dark, 'brand-border'), resolved(themes.dark, 'sidebar')];
    if (border === null || sidebar === null || contrast(border, sidebar) < BRAND_BORDER_CONTRAST) {
      bad = true;
      fail('phase-palette', `dark --brand-border (${border ?? 'unresolved'}) on --sidebar (${sidebar ?? 'unresolved'}) is below ${BRAND_BORDER_CONTRAST}:1 — lighten --brand-border so the brand tile edge stays visible`);
    }
    if (!bad) ok();
  }
}
