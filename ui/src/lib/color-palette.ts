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
