import { useMemo } from 'react';
import { Project, TypeId, type ProjectBrand } from '@sdk';
import { fsStore } from '@sdk/stores/fsStore';
import { hexToHsl, inkFor } from '@src/hooks/useColorPalette';

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

/** `#rrggbb` / `#rgb` → the `H S% L%` triple Tailwind's `hsl(var(--brand))`
 *  expects, or null when unparseable. The conversion itself is `hexToHsl` —
 *  this only adds validation. */
export function accentToHslTriple(accent: string): string | null {
  const raw = accent.trim();
  // Validate only — `hexToHsl` already owns `#`-stripping and 3→6 expansion, so
  // re-normalizing here would put that rule in two places. Validation belongs
  // on this side because an unparseable accent must fall back to the app
  // default rather than paint the container transparent via NaN.
  if (!/^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return null;
  return hexToHsl(raw);
}

export function useHelpdeskBrand(project?: Project | null): HelpdeskBrand {
  const projectTypeId = useMemo(
    () => (project?.id ? new TypeId(Project.type, project.id) : undefined),
    [project?.id],
  );
  const brand: ProjectBrand | null | undefined = project?.customization?.brand;

  // Computed unconditionally — the memo already gives the unbranded case a
  // stable identity, so a separate EMPTY sentinel and its guard bought nothing.
  return useMemo(() => {
    const triple = brand?.accent ? accentToHslTriple(brand.accent) : null;
    return {
      name: brand?.name ?? null,
      tagline: brand?.tagline ?? null,
      logoUrl:
        brand?.logo && projectTypeId ? fsStore.getState().getDownloadUrl(projectTypeId, brand.logo) : null,
      logoDarkUrl:
        brand?.logo_dark && projectTypeId
          ? fsStore.getState().getDownloadUrl(projectTypeId, brand.logo_dark)
          : null,
      accentStyle: triple
        ? // Ink derived from the accent, not assumed. A site-configured pastel or
          // yellow with hardcoded white here is the same 1.9:1 defect this file's
          // own header describes in `useColorPalette`.
          ({ '--brand': triple, '--brand-foreground': inkFor(triple) } as React.CSSProperties)
        : undefined,
    };
  }, [brand, projectTypeId]);
}
