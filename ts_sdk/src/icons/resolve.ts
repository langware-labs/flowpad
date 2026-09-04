import { normalizeTag, tagAncestors } from '../tags/grammar';
import { iconAssetUrl, isIconPath } from '../utils/icon-asset';
import type { IconPackSpec, IconResolution, IconSpec } from './types';

/**
 * Turning an icon tag into something renderable.
 *
 * Icons are named in the repo's ONE dot grammar (`tags/grammar.ts`), the same
 * one that serves bus tags and the kind ontology:
 *
 *     brands.slack            a pack's icon
 *     brands.claude.restore   a role — one more segment
 *     Rss                     a bare legacy name; normalizes to a leaf tag
 *     icons/my_type.svg       a path — a location, never a name
 *
 * **Resolution is best-match** — the deepest registered ancestor. So
 * `brands.claude.restore` resolves to itself when that role exists and to
 * `brands.claude` when it does not, and the result says which happened via
 * `degraded`. An icon is decoration; a base glyph beats nothing. The walk is
 * `tagAncestors`, so nothing here parses a tag by hand.
 *
 * Theme is deliberately not in the grammar. A `dark` variant comes back
 * alongside the default and is selected by CSS, never by a caller passing a
 * theme in — the viewer has three states and only two are legible to JS.
 *
 * This module is pure and has no React in it.
 */

/** `BarChart3` -> `bar-chart-3`. Runs BEFORE normalization: normalizing first
 *  lowercases the word boundaries the slug needs out of existence. */
export function kebab(name: string): string {
  return name.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])/g, '-').toLowerCase();
}

/** A caller's string as a tag, or `null` if it is not one. */
export function iconTag(value: string): string | null {
  try {
    return normalizeTag(kebab(value));
  } catch {
    return null;
  }
}

function assetUrl(pack: IconPackSpec, asset: string | undefined): string | undefined {
  if (!asset) return undefined;
  const base = (pack.base || '').replace(/\/$/, '');
  return iconAssetUrl(base ? `${base}/${asset}` : asset);
}

/** A pack that declares a family rather than carrying one. */
function isBundle(pack: IconPackSpec): boolean {
  return !pack.icons || pack.icons.length === 0;
}

/** Every key an icon answers to: its own leaf, and each alias. */
function keysFor(spec: IconSpec): string[] {
  return [spec.kind, ...(spec.aliases || []).map((a) => iconTag(a) || a)];
}

type Hit = { pack: IconPackSpec; spec: IconSpec; role: string };

/** One addressable key to the icon that owns it. */
function lookup(packs: IconPackSpec[], key: string): Hit | null {
  const [head, ...restParts] = key.split('.');
  for (const pack of packs) {
    for (const spec of pack.icons || []) {
      const keys = keysFor(spec);
      // Qualified: `<pack>.<leafOrAlias>[.role]`
      if (head === pack.kind && restParts.length) {
        const leaf = restParts[0];
        const role = restParts[1] || '';
        if (keys.includes(leaf) && (!role || (spec.sub || {})[role])) {
          return { pack, spec, role };
        }
      }
      // Bare: `<leafOrAlias>` with no pack segment.
      if (!restParts.length && keys.includes(head)) return { pack, spec, role: '' };
    }
  }
  return null;
}

function build(hit: Hit, asked: string, degraded: boolean, packs: IconPackSpec[]): IconResolution {
  const { pack, spec, role } = hit;
  const tag = `${pack.kind}.${spec.kind}` + (role ? `.${role}` : '');
  const tintable = spec.tintable !== false;
  const color = spec.color || '';
  const subTag = role ? (spec.sub || {})[role] : '';
  const badge = subTag ? orUndefined(resolveIcon(subTag, packs, false)) : undefined;
  const url = assetUrl(pack, spec.asset);
  if (!url) {
    return { kind: 'bundle', pack: pack.kind, tag, asked, degraded, name: spec.kind, tintable, color, badge };
  }
  return {
    kind: 'asset',
    pack: pack.kind,
    tag,
    asked,
    degraded,
    url,
    tintable,
    color,
    darkUrl: assetUrl(pack, spec.dark),
    badge,
  };
}

/** A bundle pack answering for a leaf it does not list, if it serves it. */
function bundleHit(packs: IconPackSpec[], key: string, asked: string, degraded: boolean): IconResolution | null {
  const dot = key.lastIndexOf('.');
  if (dot < 0) return null;
  const [head, leaf] = [key.slice(0, dot), key.slice(dot + 1)];
  const pack = packs.find((p) => p.kind === head && isBundle(p));
  // `served` is authoritative when the backend sent it: the same set Python
  // validates against. Without this a typo resolves to a URL and 404s silently.
  if (!pack || (pack.served && !pack.served.includes(leaf))) return null;
  return {
    kind: 'bundle',
    pack: pack.kind,
    tag: `${pack.kind}.${leaf}`,
    asked,
    degraded,
    name: leaf,
    url: assetUrl(pack, `${leaf}.svg`),
    tintable: true,
    color: '',
  };
}

/**
 * Resolve one reference against the packs.
 *
 * `packs` arrive from the backend (bootstrap's `icon_packs`, or the `icons`
 * action). Pack order no longer decides anything for a qualified tag — a full
 * tag names exactly one icon — it only breaks the tie for a bare legacy name.
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

  const asked = iconTag(raw);
  if (!asked) return { kind: 'none', ref: raw };

  // Deepest registered ancestor wins; `tagAncestors` runs broadest-first.
  const chain = tagAncestors(asked, true).reverse();
  for (let depth = 0; depth < chain.length; depth++) {
    const key = chain[depth];
    const degraded = depth > 0;
    const hit = lookup(packs, key);
    if (hit) return build(hit, asked, degraded, allowSub ? packs : []);
    const bundle = bundleHit(packs, key, asked, degraded);
    if (bundle) return bundle;
  }

  // A bare leaf naming no pack — legacy `Rss`, `Slack`. Arbitrary by
  // definition: whichever pack answers first. Not a degradation.
  if (!asked.includes('.')) {
    for (const pack of packs) {
      const bundle = bundleHit(packs, `${pack.kind}.${asked}`, asked, false);
      if (bundle) return bundle;
    }
  }
  return { kind: 'none', ref: raw };
}

/** A resolution worth drawing, or nothing. Keeps `badge` absent rather than
 *  carrying a `none` nobody can render. */
function orUndefined(res: IconResolution): IconResolution | undefined {
  return res.kind === 'none' ? undefined : res;
}
