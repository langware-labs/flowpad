/**
 * WCAG relative-luminance / contrast-ratio math (WCAG 2.x, sRGB).
 *
 * Used by the curated entity color palette (`color-palette.ts`) and its
 * enforcement vitest: every swatch must clear the non-text contrast minimum
 * (WCAG 1.4.11, 3:1) against BOTH theme backgrounds, so a Group/Prompt color
 * is readable in dark and light mode by construction.
 */

/** Parse #rgb / #rrggbb into [r, g, b] (0-255). Throws on malformed input. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`invalid hex color: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of an sRGB hex color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}
