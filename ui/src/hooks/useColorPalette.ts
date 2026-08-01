import { ISiteConfig } from '@sdk';
import { useEffect, useState } from 'react';
import { contrastRatio, hslTripleToRgb } from '@src/lib/color-palette';

/**
 * Convert a hex color to the `H S% L%` triple `hsl(var(--x))` expects.
 *
 * Exported because more than one surface needs the conversion without the
 * palette hook's `documentElement` side effect (see `accentToHslTriple`).
 */
export function hexToHsl(hex: string): string {
  // Remove # if present and ensure 6 characters
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }

  // Parse hex values using modern slice method
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

//: Mirrors `--primary` / `--primary-foreground` in `styles/index.css` — pinned
//: here because the ink has to be a value the contrast maths can weigh, not a
//: `var()`. A theme retune should move both.
const INK_DARK = '0 0% 9%';
const INK_LIGHT = '0 0% 98%';

/**
 * The readable ink for a background, as an `H S% L%` triple.
 *
 * `--primary` is overridden at runtime from site config, but `--primary-foreground`
 * is a THEME constant — so a light accent kept whatever ink the theme had picked
 * for the theme's own primary. On the vibe views that ink is white, which is how a
 * pastel button ended up with white text at 1.9:1. The ink has to be derived from
 * the colour actually in use, not from the colour the theme assumed.
 */
export function inkFor(background: string): string {
  const bg = hslTripleToRgb(background);
  // Pick whichever of the two inks wins, so a yellow accent gets black and a
  // navy one gets white.
  return contrastRatio(bg, hslTripleToRgb(INK_DARK)) >= contrastRatio(bg, hslTripleToRgb(INK_LIGHT))
    ? INK_DARK
    : INK_LIGHT;
}

/**
 * The accent, adjusted to sit on the current theme's background.
 *
 * The dark-mode lift is capped rather than open-ended. Lifting by 60% of the
 * remaining range took the default indigo (59% lightness, a comfortable 7.2:1
 * under white text) to 84% — a pastel that no ink reads well on, and that stops
 * looking like the brand colour at all. A ceiling keeps a dark accent visible on
 * a dark background without bleaching an already-bright one.
 */
const DARK_LIGHTNESS_CEILING = 60;

export function generateThemeColor(hex: string, isDark: boolean): string {
  const hsl = hexToHsl(hex);
  const [h, s, l] = hsl.split(' ').map((part, index) => {
    if (index === 0) return parseInt(part); // hue
    return parseFloat(part.replace('%', '')); // saturation and lightness
  });

  if (isDark) {
    // Lift only as far as the ceiling, and never darken a colour that already
    // clears it — the `min` alone would drag a bright accent DOWN to the
    // ceiling, so `max(l, …)` holds the floor at the original lightness.
    const darkLightness = Math.max(l, Math.min(DARK_LIGHTNESS_CEILING, l + (100 - l) * 0.6));
    return `${h} ${s}% ${darkLightness}%`;
  } else {
    // For light theme: use the original color
    return `${h} ${s}% ${l}%`;
  }
}

/**
 * Hook to manage color palette from site config
 * Returns a single color that fits the current theme
 */
export function useColorPalette(siteConfig: ISiteConfig | null | undefined) {
  const [isDark, setIsDark] = useState(false);
  const primaryColorHex = siteConfig?.colors?.primary_color || '#4f46e5'; // Default to indigo-600 hex

  // Generate the appropriate color for the current theme
  const primaryColor = generateThemeColor(primaryColorHex, isDark);

  // Detect theme changes by observing DOM class changes
  useEffect(() => {
    const checkTheme = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };

    checkTheme();

    // Listen for theme changes
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  // Apply CSS custom properties to the document root
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--primary', primaryColor);
    // Set as a PAIR. Overriding the background without its ink is what left
    // every primary button reading whatever the theme guessed.
    root.style.setProperty('--primary-foreground', inkFor(primaryColor));

    // Cleanup function to remove properties when component unmounts
    return () => {
      root.style.removeProperty('--primary');
      root.style.removeProperty('--primary-foreground');
    };
  }, [primaryColor]);

  return {
    primaryColor,
  };
}
