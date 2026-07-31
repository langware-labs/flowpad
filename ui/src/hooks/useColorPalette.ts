import { ISiteConfig } from '@sdk';
import { useEffect, useState } from 'react';

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

/**
 * Generate theme-appropriate color based on current theme
 */
function generateThemeColor(hex: string, isDark: boolean): string {
  const hsl = hexToHsl(hex);
  const [h, s, l] = hsl.split(' ').map((part, index) => {
    if (index === 0) return parseInt(part); // hue
    return parseFloat(part.replace('%', '')); // saturation and lightness
  });

  if (isDark) {
    // For dark theme: adjust lightness to be more visible on dark backgrounds
    // Increase lightness for better contrast on dark backgrounds
    const darkLightness = Math.min(95, l + (100 - l) * 0.6); // Increase lightness by 60% of remaining range
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

    // Cleanup function to remove properties when component unmounts
    return () => {
      root.style.removeProperty('--primary');
    };
  }, [primaryColor]);

  return {
    primaryColor,
  };
}
