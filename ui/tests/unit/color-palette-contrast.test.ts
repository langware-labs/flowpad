/**
 * The accent and its ink must stay legible together.
 *
 * `--primary` is overridden at runtime from site config while `--primary-foreground`
 * is a theme constant, so the two used to be chosen independently: the dark-mode
 * lift took the default indigo to a pastel and the theme's white ink stayed put,
 * leaving every primary button — the device sign-in button among them — at 1.9:1.
 * These pin the two rules that fixed it: the lift is capped, and the ink is derived
 * from the colour actually in use.
 *
 * The contrast maths is IMPORTED, not re-implemented. A copy would be neither reuse
 * nor an independent check: made from the same source, it reproduces the same bug and
 * still passes. Independence comes from the anchors below — ratios with a published
 * value — and from the literal `inkFor` expectations, which assert an outcome without
 * going through the maths at all.
 */
import { describe, it, expect } from 'vitest';
import { generateThemeColor, hexToHsl, inkFor } from '@src/hooks/useColorPalette';
import { MIN_CONTRAST_TEXT, contrastRatio, hexToRgb, hslTripleToRgb } from '@src/lib/color-palette';

const ratio = (bgTriple: string, inkTriple: string) =>
  contrastRatio(hslTripleToRgb(bgTriple), hslTripleToRgb(inkTriple));

describe('contrast maths', () => {
  // Published values — these fail if the luminance formula drifts, which a copy
  // of the implementation could never detect.
  it('matches known WCAG ratios', () => {
    expect(contrastRatio(hexToRgb('#ffffff'), hexToRgb('#000000'))).toBeCloseTo(21, 5);
    expect(contrastRatio(hexToRgb('#ffffff'), hexToRgb('#ffffff'))).toBeCloseTo(1, 5);
    // sRGB mid-grey #767676 is the canonical "just passes 4.5:1 on white" swatch.
    expect(contrastRatio(hexToRgb('#767676'), hexToRgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hexToRgb('#777777'), hexToRgb('#ffffff'))).toBeLessThan(4.6);
  });

  it('agrees between the hex and hsl routes', () => {
    // Two independent parsers reaching one colour: hex → rgb directly, versus
    // hex → hsl → rgb. Compared per channel rather than via a derived ratio,
    // which amplifies the error. `hexToHsl` rounds H/S/L to whole numbers, so
    // the round trip lands near the original rather than exactly on it.
    for (const hex of ['#4f46e5', '#ffdd33', '#062d79', '#86eff9']) {
      const viaHex = hexToRgb(hex);
      const viaHsl = hslTripleToRgb(hexToHsl(hex));
      viaHsl.forEach((channel, i) => expect(channel).toBeCloseTo(viaHex[i], 1));
    }
  });
});

// The default (indigo-600) plus accents that bracket the range a site config can
// supply — one already brighter than the dark-mode ceiling, one very dark.
const ACCENTS = ['#4f46e5', '#ffdd33', '#062d79', '#86eff9', '#000000', '#ffffff'];

describe('accent / ink contrast', () => {
  for (const hex of ACCENTS) {
    for (const isDark of [false, true]) {
      it(`${hex} on the ${isDark ? 'dark' : 'light'} theme clears AA`, () => {
        const bg = generateThemeColor(hex, isDark);
        expect(ratio(bg, inkFor(bg))).toBeGreaterThanOrEqual(MIN_CONTRAST_TEXT);
      });
    }
  }

  it('caps the dark-mode lift instead of bleaching the accent to a pastel', () => {
    // The regression: 59% lightness was lifted to 83.6%, which no ink reads well
    // on and which stops looking like the brand colour.
    const lightness = Number.parseFloat(generateThemeColor('#4f46e5', true).split(' ')[2]);
    expect(lightness).toBeLessThanOrEqual(60);
  });

  it('does not drag an already-bright accent down to the ceiling', () => {
    const lightness = Number.parseFloat(generateThemeColor('#86eff9', true).split(' ')[2]);
    expect(lightness).toBeGreaterThan(60);
  });

  it('picks the ink from the colour, not the theme', () => {
    expect(inkFor('50 100% 60%')).toBe('0 0% 9%'); // bright yellow -> black
    expect(inkFor('220 90% 25%')).toBe('0 0% 98%'); // deep navy -> white
  });
});
