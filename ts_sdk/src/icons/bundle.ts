import type { ComponentType } from 'react';

/**
 * The bundle seam — how a `kind: 'bundle'` icon gets drawn from the renderer's
 * own geometry instead of a network fetch.
 *
 * `ts_sdk` depends on `dotenv` and nothing else; it cannot import `lucide-react`,
 * and React is external by design ("an app that doesn't use them should not pay
 * for a bundled React"). So the SDK cannot look a bundle glyph up itself — the
 * app hands it the lookup once, at startup:
 *
 *     registerBundleRenderer(name => (lucideIcons as Record<string, unknown>)[name]);
 *
 * Without this the bundle case falls back to fetching
 * `icons/lucide/assets/rss.svg`, which would turn today's tree-shaken inline SVG
 * into one HTTP request per glyph. The `bundle` type already claims "the
 * renderer already has the geometry"; this is what makes that claim true.
 *
 * The lookup takes the LEAF (`rss`, `bar-chart-3`), because that is what the tag
 * carries. Libraries keyed by PascalCase — lucide is — can use `pascalLeaf`
 * rather than every app copying the same regex.
 */

/** `bar-chart-3` -> `BarChart3`, the inverse of `kebab`, for a library whose
 *  exports are PascalCase. */
export function pascalLeaf(leaf: string): string {
  return leaf.replace(/(^|-)([a-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase());
}

export type BundleIcon = ComponentType<{ className?: string } & Record<string, unknown>>;

/** Look a bundle glyph up by its leaf name. Returns undefined when unknown. */
export type BundleRenderer = (name: string) => BundleIcon | undefined;

let renderer: BundleRenderer | null = null;

/** Install the app's bundle lookup. Call once, before the first render. */
export function registerBundleRenderer(fn: BundleRenderer | null): void {
  renderer = fn;
}

/** The component for a bundle leaf, or `undefined` — the caller then falls back
 *  to the served file, which is what a plain HTML page does. */
export function bundleIcon(name: string): BundleIcon | undefined {
  return renderer ? renderer(name) : undefined;
}
