/**
 * Curated, contrast-tested entity color palette.
 *
 * Every swatch is a mid-tone chosen to clear the WCAG 1.4.11 non-text
 * contrast minimum (3:1) against BOTH theme backgrounds — light
 * (`--background: 0 0% 100%` → #ffffff) and dark (`0 0% 3.9%` → #0a0a0a) —
 * so a stored entity color (Group folder, Prompt, …) is readable in either
 * theme by construction. `ui/tests/unit/color-contrast.test.ts` ENFORCES
 * this for every entry: adding a swatch that fails either background breaks
 * the build, which is the whole point — no runtime contrast math, no
 * unreadable user choices.
 *
 * Values are stored on entities as plain hex (`color` fields).
 */

export interface PaletteSwatch {
  /** Stable token (storage-friendly name, also the swatch tooltip). */
  token: string;
  /** The stored value. */
  hex: string;
}

/** Theme backgrounds the palette is verified against (styles/index.css). */
export const THEME_BACKGROUNDS = {
  light: '#ffffff',
  dark: '#0a0a0a',
} as const;

/** WCAG 1.4.11 non-text minimum. */
export const MIN_CONTRAST = 3.0;

/** WCAG 1.4.3 minimum for normal-size text. */
export const MIN_CONTRAST_TEXT = 4.5;

/** sRGB channels, 0-1. */
export type Rgb = [number, number, number];

/** `#rgb` / `#rrggbb` → sRGB channels, 0-1. */
export function hexToRgb(hex: string): Rgb {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

/**
 * `H S% L%` (the triple `hsl(var(--x))` expects) → sRGB channels, 0-1.
 *
 * The CSS Color 4 formulation: no sextant branch table to check by hand, so
 * there are no hue-boundary cases to get wrong.
 */
export function hslTripleToRgb(triple: string): Rgb {
  const [h, sPct, lPct] = triple.split(' ').map(Number.parseFloat);
  const s = sPct / 100;
  const l = lPct / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1:1 … 21:1. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const ENTITY_COLOR_PALETTE: readonly PaletteSwatch[] = [
  { token: 'red', hex: '#dc2626' },
  { token: 'orange', hex: '#ea580c' },
  { token: 'amber', hex: '#d97706' },
  // yellow-700: yellow-600 (#ca8a04) measures 2.94:1 on white — the gate
  // test caught it; one shade darker clears both themes.
  { token: 'yellow', hex: '#a16207' },
  { token: 'lime', hex: '#65a30d' },
  { token: 'green', hex: '#16a34a' },
  { token: 'emerald', hex: '#059669' },
  { token: 'teal', hex: '#0d9488' },
  { token: 'cyan', hex: '#0891b2' },
  { token: 'sky', hex: '#0284c7' },
  { token: 'blue', hex: '#3b82f6' },
  { token: 'indigo', hex: '#6366f1' },
  { token: 'violet', hex: '#8b5cf6' },
  { token: 'fuchsia', hex: '#c026d3' },
  { token: 'pink', hex: '#db2777' },
  { token: 'rose', hex: '#e11d48' },
  { token: 'slate', hex: '#64748b' },
] as const;
