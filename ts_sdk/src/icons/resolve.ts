import { iconAssetUrl, isIconPath } from '../utils/icon-asset';
import type { IconPackSpec, IconResolution, IconSpec } from './types';

/**
 * Turning an icon reference into something renderable.
 *
 * The grammar is four forms and no more:
 *
 *     Rss                     bare — packs in order, i.e. exactly today's behaviour
 *     brands:slack            qualified
 *     brands:claude@restore   a variant
 *     icons/my_type.svg       a path — still works, still resolved last
 *
 * Theme is deliberately not in that list. A `dark` variant is handed back
 * alongside the default artwork and selected by CSS, never by a caller passing a
 * theme in — the viewer has three states and only two are legible to JS (an
 * explicit choice stamps the document; the default "system" setting stamps
 * nothing at all). CSS can see all three, so CSS decides.
 *
 * This module is pure and has no React in it. `useIcon` is a thin wrapper.
 */

/** Lucide's own file-slug convention: `BarChart3` -> `bar-chart-3`. */
export function kebab(name: string): string {
  return name.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])/g, '-').toLowerCase();
}

function assetUrl(pack: IconPackSpec, asset: string): string | undefined {
  if (!asset) return undefined;
  const base = (pack.base || '').replace(/\/$/, '');
  return iconAssetUrl(base ? `${base}/${asset}` : asset);
}

/** A pack that declares a family rather than carrying one. */
function isBundle(pack: IconPackSpec): boolean {
  return !pack.icons || pack.icons.length === 0;
}

function findSpec(pack: IconPackSpec, name: string): IconSpec | undefined {
  return (pack.icons || []).find((s) => s.name === name || (s.aliases || []).includes(name));
}

/**
 * Resolve one reference against the packs, in order.
 *
 * `packs` arrive from the backend (bootstrap's `icon_packs`, or the `icons`
 * action) already in resolution order — earlier packs win a bare name, which is
 * what preserves the existing rule that a bespoke glyph beats a lucide export of
 * the same name.
 */
export function resolveIcon(
  ref: string | null | undefined,
  packs: IconPackSpec[],
  /** Internal: sub-icons resolve one level deep and no further. */
  allowSub = true,
): IconResolution {
  const raw = (ref || '').trim();
  if (!raw) return { kind: 'none', ref: '' };

  // A path is already a location. `iconAssetUrl` is the one place allowed to
  // turn one into a URL, so hand it straight over.
  if (isIconPath(raw) || raw.startsWith('data:')) {
    const url = iconAssetUrl(raw);
    return url ? { kind: 'path', url } : { kind: 'none', ref: raw };
  }

  const [head, variant = ''] = raw.split('@', 2);
  const qualified = head.includes(':');
  const [packName, bare] = qualified ? [head.slice(0, head.indexOf(':')), head.slice(head.indexOf(':') + 1)] : ['', head];

  const candidates = qualified ? packs.filter((p) => p.name === packName) : packs;

  for (const pack of candidates) {
    const spec = findSpec(pack, bare);

    if (spec) {
      const baked = variant ? (spec.variants || {})[variant] : '';
      const composed = variant && !baked ? (spec.sub || {})[variant] : '';
      if (variant && !baked && !composed) {
        // The icon exists but not in that role — a miss, not a silent default.
        return { kind: 'none', ref: raw };
      }
      // A role declared both ways is not an error: the vendor's own drawing
      // beats a generic badge, so the baked file wins and `sub` goes unused.
      const asset = baked || spec.asset || '';
      const url = assetUrl(pack, asset);
      const tintable = spec.tintable !== false;
      const color = spec.color || '';
      const badge =
        composed && allowSub ? orUndefined(resolveIcon(composed, packs, false)) : undefined;
      if (!url) {
        return { kind: 'bundle', pack: pack.name, name: spec.name, tintable, color, badge };
      }
      return {
        kind: 'asset',
        pack: pack.name,
        name: spec.name,
        url,
        tintable,
        color,
        darkUrl: assetUrl(pack, (spec.variants || {}).dark || ''),
        badge,
      };
    }

    // A bundle pack answers for a name it does not list — the renderer holds
    // the geometry. Its `base`, when set, also serves a file, which is what
    // lets a caller with no React render the same icon.
    //
    // `served` is authoritative when the backend sent it: it is the set of
    // names that pack actually has artwork for, and it is the same set Python
    // validates against. Without this check a typo would resolve to a URL and
    // 404 silently — which is precisely the failure this registry exists to
    // end. An older backend sends no `served`; then the pack still claims the
    // name, because its renderer may hold the glyph even where no file does.
    if (isBundle(pack) && !variant) {
      const slug = kebab(bare);
      if (pack.served && !pack.served.includes(slug)) continue;
      return {
        kind: 'bundle',
        pack: pack.name,
        name: bare,
        url: assetUrl(pack, `${slug}.svg`),
        tintable: true,
        color: '',
      };
    }
  }

  return { kind: 'none', ref: raw };
}

/** A resolution worth drawing, or nothing. Keeps `badge` absent rather than
 *  carrying a `none` nobody can render. */
function orUndefined(res: IconResolution): IconResolution | undefined {
  return res.kind === 'none' ? undefined : res;
}
