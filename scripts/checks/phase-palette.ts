import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

const THEME_REL = 'apps/desktop/src/renderer/styles/theme.css';
const DESIGN_REL = 'docs/DESIGN.md';
const LABELS_REL = 'plugins/port/data/labels.json';
const HUE_TOLERANCE = 25;
const REFRESH_SATURATION_CEILING = 0.15;
const TEXT_CONTRAST = 4.5;
const DOT_CONTRAST = 3.0;
const HUE_SEPARATION = 30;
const PILL_SATURATION = 0.6;
const SURFACE_STEP = 4;
const ACCENT_SATURATION = 0.25;
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

function lstar(hex: string): number {
  const y = luminance(hex);
  return y < 0.008856 ? 903.3 * y : 116 * Math.cbrt(y) - 16;
}

function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = [channel(hex, 0), channel(hex, 2), channel(hex, 4)];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (sector * 60 + 360) % 360, s, l };
}

const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

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

interface DesignRow {
  palette: string;
  keys: string[];
  pill: { light: string[]; dark: string[] };
  dot: string[];
}

/** The rows of DESIGN §1's "Phase palette" table, or `null` when the table is missing or malformed. */
function designRows(design: string): DesignRow[] | null {
  const lines = design.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('### Phase palette'));
  if (start === -1) return null;
  const rows: DesignRow[] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const palette = /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1];
    if (cells.length !== 6 || palette === undefined) continue;
    const hexes = (cell: string) => [...cell.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0].toLowerCase());
    rows.push({
      palette,
      keys: [...cells[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      pill: { light: hexes(cells[3]), dark: hexes(cells[4]) },
      dot: hexes(cells[5]),
    });
  }
  return rows.length > 0 ? rows : null;
}

// One palette per pipeline phase, pinned across labels.json, theme.css and DESIGN §1 — a hue that drifts in one place breaks the "same colour everywhere" promise silently.
// Also pins distinct phase hues, solid pills, stepped dark surfaces and a brand-hued accent.
export default async function ({ expect, fail, ok }: Reporter) {
  // --- Self-test: the colour maths must give the textbook answers, or every rule below is noise ---
  {
    expect(Math.abs(contrast('ffffff', '000000') - 21) < 0.01, 'phase-palette', 'contrast(white, black) is not 21 — the WCAG formula is broken');
    expect(Math.abs(hsl('ff0000').h) < 0.5 && Math.abs(hsl('00ff00').h - 120) < 0.5 && Math.abs(hsl('0000ff').h - 240) < 0.5, 'phase-palette', 'hsl() does not give the pure red/green/blue hues');
    expect(hueGap(350, 10) === 20, 'phase-palette', 'hueGap does not wrap around 0°');
    expect(Math.abs(lstar('ffffff') - 100) < 0.01 && Math.abs(lstar('000000')) < 0.01, 'phase-palette', 'lstar() does not map white to 100 and black to 0');
  }

  const labels: { key: string; color: string; role: string; palette: string | null }[] = readJson(LABELS_REL).labels;
  const rows = designRows(readFileSync(join(root, DESIGN_REL), 'utf8'));
  if (rows === null) {
    fail('phase-palette', `${DESIGN_REL} has no §1 "Phase palette" table with six-column rows — add it, one row per palette`);
    return;
  }
  const css = readFileSync(join(root, THEME_REL), 'utf8');
  const themes = { light: themeBlock(css, 'light'), dark: themeBlock(css, 'dark') };

  // --- (a) DESIGN §1's table and labels.json agree on every palette and its member keys, both directions ---
  {
    let bad = false;
    const byPalette = new Map<string, string[]>();
    for (const l of labels.filter((x) => x.palette !== null)) byPalette.set(l.palette!, [...(byPalette.get(l.palette!) ?? []), l.key]);
    const designed = new Map(rows.map((r) => [r.palette, r.keys]));
    for (const [palette, keys] of byPalette) {
      const inDesign = designed.get(palette);
      if (inDesign === undefined) {
        bad = true;
        fail('phase-palette', `labels.json uses palette '${palette}', which has no row in ${DESIGN_REL} §1 "Phase palette" — add the row`);
      } else if ([...keys].sort().join() !== [...inDesign].sort().join()) {
        bad = true;
        fail('phase-palette', `palette '${palette}' lists ${keys.join(', ')} in labels.json but ${inDesign.join(', ')} in ${DESIGN_REL} §1 — make the two lists match`);
      }
    }
    for (const palette of designed.keys()) {
      if (!byPalette.has(palette)) {
        bad = true;
        fail('phase-palette', `${DESIGN_REL} §1 has a row for palette '${palette}', which no labels.json entry uses — remove the row or give a label that palette`);
      }
    }
    if (!bad) ok();
  }

  // --- (b) DESIGN §1's hex values match theme.css's resolved values, both themes ---
  {
    let bad = false;
    for (const row of rows) {
      const expected: [string, 'light' | 'dark', string | undefined][] = [
        [`phase-${row.palette}-pill`, 'light', row.pill.light[0]],
        [`phase-${row.palette}-pill-foreground`, 'light', row.pill.light[1]],
        [`phase-${row.palette}-pill`, 'dark', row.pill.dark[0]],
        [`phase-${row.palette}-pill-foreground`, 'dark', row.pill.dark[1]],
        [`phase-${row.palette}-dot`, 'light', row.dot[0]],
        [`phase-${row.palette}-dot`, 'dark', row.dot[1]],
      ];
      for (const [name, theme, documented] of expected) {
        const actual = resolved(themes[theme], name);
        if (actual === null || actual !== documented) {
          bad = true;
          fail('phase-palette', `--${name} resolves to ${actual ?? 'nothing'} in the ${theme} theme of ${THEME_REL}, but ${DESIGN_REL} §1 documents ${documented ?? 'nothing'} — make the two agree`);
        }
      }
    }
    if (!bad) ok();
  }

  const members = (palette: string) => labels.filter((l) => l.palette === palette);
  const lightDot = (palette: string) => resolved(themes.light, `phase-${palette}-dot`);

  // --- (c) exactly one label per palette wears the light dot colour: the anchor GitHub and the app share ---
  {
    let bad = false;
    for (const row of rows) {
      const dot = lightDot(row.palette);
      const anchors = members(row.palette).filter((l) => dot !== null && bare(l.color) === bare(dot));
      if (anchors.length !== 1) {
        bad = true;
        fail('phase-palette', `palette '${row.palette}' has ${anchors.length} labels coloured ${dot ?? '(no light dot)'} in ${LABELS_REL}, expected exactly one — set its in-flight label to the light --phase-${row.palette}-dot, or move the dot`);
      }
    }
    if (!bad) ok();
  }

  // --- (d) every member stays on its anchor's hue; refresh stays grey ---
  {
    let bad = false;
    for (const row of rows) {
      const dot = lightDot(row.palette);
      if (dot === null) continue;
      for (const l of members(row.palette)) {
        const color = l.color.toLowerCase();
        if (row.palette === 'refresh') {
          if (hsl(color).s >= REFRESH_SATURATION_CEILING) {
            bad = true;
            fail('phase-palette', `'${l.key}' (${l.color}) is not grey: saturation ${hsl(color).s.toFixed(2)} is at or above ${REFRESH_SATURATION_CEILING} — the refresh palette is neutral`);
          }
        } else if (hueGap(hsl(color).h, hsl(dot).h) > HUE_TOLERANCE) {
          bad = true;
          fail('phase-palette', `'${l.key}' (${l.color}) is ${Math.round(hueGap(hsl(color).h, hsl(dot).h))}° from palette '${row.palette}'s anchor ${dot}, over the ${HUE_TOLERANCE}° limit — one palette is one hue`);
        }
      }
    }
    if (!bad) ok();
  }

  // --- (e) a queued trigger is lighter than its anchor ---
  {
    let bad = false;
    for (const row of rows) {
      const dot = lightDot(row.palette);
      if (dot === null) continue;
      for (const l of members(row.palette).filter((x) => x.role === 'trigger')) {
        if (luminance(l.color.toLowerCase()) <= luminance(dot)) {
          bad = true;
          fail('phase-palette', `trigger '${l.key}' (${l.color}) is not lighter than palette '${row.palette}'s anchor ${dot} — a queued label must be the lighter shade`);
        }
      }
    }
    if (!bad) ok();
  }

  // --- (f) WCAG: pill text 4.5:1 on its pill, every dot 3:1 on the background, the sidebar and the selected row, in both themes ---
  {
    let bad = false;
    for (const theme of ['light', 'dark'] as const) {
      const block = themes[theme];
      const [background, sidebar, selection] = [resolved(block, 'background'), resolved(block, 'sidebar'), resolved(block, 'selection')];
      for (const row of rows) {
        const pill = resolved(block, `phase-${row.palette}-pill`);
        const text = resolved(block, `phase-${row.palette}-pill-foreground`);
        const dot = resolved(block, `phase-${row.palette}-dot`);
        if (pill === null || text === null || dot === null || background === null || sidebar === null || selection === null) {
          bad = true;
          fail('phase-palette', `palette '${row.palette}' has an unresolvable colour in the ${theme} theme of ${THEME_REL} — every --phase-${row.palette}-* must resolve to a hex`);
          continue;
        }
        if (contrast(text, pill) < TEXT_CONTRAST) {
          bad = true;
          fail('phase-palette', `palette '${row.palette}' pill text ${text} on ${pill} is ${contrast(text, pill).toFixed(2)}:1 in the ${theme} theme, below ${TEXT_CONTRAST} — darken the text or lighten the pill`);
        }
        for (const [against, name] of [[background, 'background'], [sidebar, 'sidebar'], [selection, 'selection']] as const) {
          if (contrast(dot, against) < DOT_CONTRAST) {
            bad = true;
            fail('phase-palette', `palette '${row.palette}' dot ${dot} on ${name} (${against}) is ${contrast(dot, against).toFixed(2)}:1 in the ${theme} theme, below ${DOT_CONTRAST} — darken the light dot (and its anchor label) or lighten the dark one`);
          }
        }
      }
    }
    if (!bad) ok();
  }

  const coloured = rows.filter((r) => r.palette !== 'refresh');

  // --- (g) no two phases share a hue: light dots and light pill fills stay HUE_SEPARATION° apart ---
  {
    let bad = false;
    for (const token of ['dot', 'pill'] as const) {
      const hues = coloured.map((r) => [r.palette, resolved(themes.light, `phase-${r.palette}-${token}`)] as const);
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          const [a, b] = [hues[i], hues[j]];
          if (a[1] === null || b[1] === null) continue;
          const gap = hueGap(hsl(a[1]).h, hsl(b[1]).h);
          if (gap < HUE_SEPARATION) {
            bad = true;
            fail('phase-palette', `light --phase-${a[0]}-${token} (${a[1]}) and --phase-${b[0]}-${token} (${b[1]}) are ${Math.round(gap)}° apart, under ${HUE_SEPARATION}° — move one hue so the phases read as different colours`);
          }
        }
      }
    }
    if (!bad) ok();
  }

  // --- (h) a phase pill is a solid fill: saturation at least PILL_SATURATION in both themes ---
  {
    let bad = false;
    for (const theme of ['light', 'dark'] as const) {
      for (const row of coloured) {
        const pill = resolved(themes[theme], `phase-${row.palette}-pill`);
        if (pill !== null && hsl(pill).s < PILL_SATURATION) {
          bad = true;
          fail('phase-palette', `--phase-${row.palette}-pill (${pill}) has saturation ${hsl(pill).s.toFixed(2)} in the ${theme} theme, under ${PILL_SATURATION} — a phase pill is a solid fill, not a pale tint`);
        }
      }
    }
    if (!bad) ok();
  }

  // --- (i) dark surfaces step up in lightness: sidebar < background < card < muted, accent above card, selection above background ---
  {
    let bad = false;
    const dark = themes.dark;
    const steps: [string, string][] = [['sidebar', 'background'], ['background', 'card'], ['card', 'muted'], ['card', 'accent'], ['background', 'selection']];
    for (const [lower, higher] of steps) {
      const [lo, hi] = [resolved(dark, lower), resolved(dark, higher)];
      if (lo === null || hi === null) {
        bad = true;
        fail('phase-palette', `--${lower} or --${higher} does not resolve to a hex in the dark theme of ${THEME_REL}`);
      } else if (lstar(hi) - lstar(lo) < SURFACE_STEP) {
        bad = true;
        fail('phase-palette', `dark --${higher} (${hi}, L* ${lstar(hi).toFixed(1)}) is under ${SURFACE_STEP} L* above --${lower} (${lo}, L* ${lstar(lo).toFixed(1)}) — lighten --${higher} so the two surfaces separate`);
      }
    }
    if (!bad) ok();
  }

  // --- (j) accent, selection and primary stay on the brand hue, in both themes ---
  {
    let bad = false;
    for (const theme of ['light', 'dark'] as const) {
      const brand = resolved(themes[theme], 'brand');
      for (const name of ['accent', 'selection', 'primary']) {
        const value = resolved(themes[theme], name);
        if (brand === null || value === null) {
          bad = true;
          fail('phase-palette', `--${name} or --brand does not resolve to a hex in the ${theme} theme of ${THEME_REL}`);
        } else if (hueGap(hsl(value).h, hsl(brand).h) > HUE_TOLERANCE || hsl(value).s < ACCENT_SATURATION) {
          bad = true;
          fail('phase-palette', `${theme} --${name} (${value}) is ${Math.round(hueGap(hsl(value).h, hsl(brand).h))}° from --brand ${brand} at saturation ${hsl(value).s.toFixed(2)} — keep it within ${HUE_TOLERANCE}° and at least ${ACCENT_SATURATION} saturated so it reads as the brand`);
        }
      }
    }
    if (!bad) ok();
  }

  // --- (k) text on the brand-tinted surfaces reaches 4.5:1, and the dark brand tile border 3:1 on the sidebar ---
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
