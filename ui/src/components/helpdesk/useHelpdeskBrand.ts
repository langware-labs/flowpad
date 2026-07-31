import { useMemo } from 'react';
import { Project, TypeId, type ProjectBrand } from '@sdk';
import { useFS } from '@src/hooks/useFS';

/**
 * A desk's visual identity, resolved from the portal project.
 *
 * The brand ships in the cloned repo (`.flow/customization/string.json` + image
 * files) and rides along inside the Project payload, so this costs no request —
 * see `Project.customization` / `_read_brand`. The backend has already
 * confirmed the logo files exist and are inside the project root, so the paths
 * go straight to the download action.
 */
export interface HelpdeskBrand {
  name: string | null;
  tagline: string | null;
  /** Served URLs, ready for `<img src>`. Null when the desk ships no logo. */
  logoUrl: string | null;
  logoDarkUrl: string | null;
  /**
   * Inline style applying the accent to the branded container.
   *
   * Scoped on purpose. `useColorPalette` sets `--primary` on
   * `documentElement`: two mounted consumers fight over it, unmounting one
   * clears it for the other, and it never sets `--primary-foreground` (a
   * documented 1.9:1 contrast bug). `--brand`/`--brand-foreground` is the
   * theme-stable pair meant for exactly this, and setting it on a container
   * keeps one desk's accent from leaking into the rest of the app.
   */
  accentStyle: React.CSSProperties | undefined;
}

const EMPTY: HelpdeskBrand = {
  name: null,
  tagline: null,
  logoUrl: null,
  logoDarkUrl: null,
  accentStyle: undefined,
};

/** `#rrggbb` / `#rgb` → the `H S% L%` triple Tailwind's `hsl(var(--brand))`
 *  expects. Returns null for anything unparseable so a typo'd accent falls back
 *  to the app default instead of painting the container transparent. */
export function accentToHslTriple(accent: string): string | null {
  const hex = accent.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;

  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function useHelpdeskBrand(project?: Project | null): HelpdeskBrand {
  const projectTypeId = useMemo(
    () => (project?.id ? new TypeId(Project.type, project.id) : undefined),
    [project?.id],
  );
  const fs = useFS(projectTypeId);
  const brand: ProjectBrand | null | undefined = project?.customization?.brand;

  return useMemo(() => {
    if (!brand || !projectTypeId) return EMPTY;
    const triple = brand.accent ? accentToHslTriple(brand.accent) : null;
    return {
      name: brand.name ?? null,
      tagline: brand.tagline ?? null,
      logoUrl: brand.logo ? fs.getDownloadUrl(brand.logo) : null,
      logoDarkUrl: brand.logo_dark ? fs.getDownloadUrl(brand.logo_dark) : null,
      accentStyle: triple
        ? ({ '--brand': triple, '--brand-foreground': '0 0% 100%' } as React.CSSProperties)
        : undefined,
    };
  }, [brand, fs, projectTypeId]);
}
