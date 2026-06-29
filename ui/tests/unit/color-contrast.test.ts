import { describe, expect, it } from 'vitest';

import { contrastRatio, hexToRgb, relativeLuminance } from '../../src/lib/color-contrast';
import { ENTITY_COLOR_PALETTE, MIN_CONTRAST, THEME_BACKGROUNDS } from '../../src/lib/color-palette';

// THE contrast gate (user requirement: color selection is contrast-friendly):
// every curated swatch must clear WCAG 1.4.11 (3:1, non-text) against BOTH
// theme backgrounds. Add a swatch that fails either theme and this test
// fails the build — the palette is contrast-safe by construction, no runtime
// math anywhere in the UI.
describe('curated entity color palette is contrast-safe', () => {
  it('sanity: WCAG math is correct at the anchors', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(hexToRgb('#7aa2f7')).toEqual([122, 162, 247]);
    expect(() => hexToRgb('not-a-color')).toThrow();
  });

  it('has a usable spread of swatches with unique tokens and valid hex', () => {
    expect(ENTITY_COLOR_PALETTE.length).toBeGreaterThanOrEqual(12);
    const tokens = new Set(ENTITY_COLOR_PALETTE.map((s) => s.token));
    expect(tokens.size).toBe(ENTITY_COLOR_PALETTE.length);
    for (const swatch of ENTITY_COLOR_PALETTE) {
      expect(() => hexToRgb(swatch.hex)).not.toThrow();
    }
  });

  for (const [theme, background] of Object.entries(THEME_BACKGROUNDS)) {
    it(`every swatch clears ${MIN_CONTRAST}:1 on the ${theme} background (${background})`, () => {
      const failures = ENTITY_COLOR_PALETTE.filter(
        (swatch) => contrastRatio(swatch.hex, background) < MIN_CONTRAST,
      ).map((swatch) => `${swatch.token} (${swatch.hex}) = ${contrastRatio(swatch.hex, background).toFixed(2)}:1`);
      expect(failures, `swatches below ${MIN_CONTRAST}:1 on ${theme}: ${failures.join(', ')}`).toEqual([]);
    });
  }
});
