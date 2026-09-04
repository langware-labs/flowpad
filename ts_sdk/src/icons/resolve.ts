import { tagAncestors, tryTag } from '../tags/grammar';
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
 *     🎨                      not a tag at all — the value IS the glyph
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

/** A caller's string as a tag, or `null` if it is not one.
 *  `tryTag` is the grammar's own null-returning gate for untrusted input. */
export function iconTag(value: string): string | null {
  return tryTag(kebab(value));
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

type Hit = { pack: IconPackSpec; spec: IconSpec; role: string };

/**
 * Every addressable key -> the icon that owns it, built once per packs array.
 *
 * Mirrors the Python registry's `_by_tag`. Without it `lookup` was a nested
 * scan over every pack × every icon that re-derived each icon's alias list on
 * every call, once per ancestor, once per rendered glyph. The index makes it a
 * single `Map.get` and keeps the two sides of the system the same shape.
 *
 * Keyed on the array identity in a WeakMap: `loadIconPacks` replaces the array
 * when packs arrive, so a new array rebuilds and the old index is collectable.
 */
const INDEX = new WeakMap<IconPackSpec[], Map<string, Hit>>();

function indexOf(packs: IconPackSpec[]): Map<string, Hit> {
  const cached = INDEX.get(packs);
  if (cached) return cached;

  const index = new Map<string, Hit>();
  const put = (key: string, hit: Hit) => {
    if (!index.has(key)) index.set(key, hit);
  };
  for (const pack of packs) {
    for (const spec of pack.icons || []) {
      const keys = [spec.kind, ...(spec.aliases || []).map((a) => iconTag(a) || a)];
      for (const key of keys) {
        // Qualified is the identity; the bare key is the legacy spelling and is
        // deliberately first-wins, which is what makes it arbitrary.
        put(`${pack.kind}.${key}`, { pack, spec, role: '' });
        put(key, { pack, spec, role: '' });
        for (const role of Object.keys(spec.sub || {})) {
          put(`${pack.kind}.${key}.${role}`, { pack, spec, role });
        }
      }
    }
  }
  INDEX.set(packs, index);
  return index;
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

  // Not a tag and not a path: the value IS the glyph. An emoji fails the tag
  // grammar by construction (no letters), which is exactly the discriminator —
  // no guessing from punctuation, no separate predicate.
  const asked = iconTag(raw);
  if (!asked) return { kind: 'text', text: raw };

  // Deepest registered ancestor wins; `tagAncestors` runs broadest-first.
  const chain = tagAncestors(asked, true).reverse();
  for (let depth = 0; depth < chain.length; depth++) {
    const key = chain[depth];
    const degraded = depth > 0;
    const hit = indexOf(packs).get(key);
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
