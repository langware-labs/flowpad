import * as lucideIcons from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { pascalLeaf, registerBundleRenderer, resolveIcon } from '@sdk/icons';
import { getIconPacks } from '@sdk/icons';
import { flowIconComponent } from '@sdk/react/FlowIcon';

/**
 * The app's icon adapter — the ONE place the frontend meets the SDK's icon
 * registry.
 *
 * Resolution itself is the SDK's: the backend publishes a tag, the packs say
 * what it draws, and `flowIconComponent` returns a component. What lives here
 * is the half only the app can supply — its lucide bundle.
 *
 * **The bundle renderer is why a lucide glyph still costs no request.** The SDK
 * depends on `dotenv` alone and cannot import `lucide-react`; without this
 * registration a `bundle` tag falls back to fetching its SVG, turning
 * tree-shaken inline geometry into one HTTP round-trip per glyph. Registered at
 * module scope because every consumer of this file imports it, so it is
 * installed before the first icon renders.
 *
 * Lucide exports PascalCase (`BarChart3`) while a tag carries the slug
 * (`bar-chart-3`); `pascalLeaf` is the SDK's inverse of that rule.
 */
registerBundleRenderer((name) => (lucideIcons as unknown as Record<string, LucideIcon>)[pascalLeaf(name)]);

/**
 * Resolve an icon component from the string the backend registry publishes.
 *
 * Kept as a function with this exact signature because 23 files call it and 58
 * more reach it through `iconForType` — it is the seam the whole app renders
 * through, so pointing it at the SDK migrates all of them without touching a
 * call site.
 *
 * The old ladder (a bespoke component table, then a served file, then a lucide
 * export, then `FileText`) now lives in the packs and the resolver. The
 * fallback is unchanged in effect: a null name, a typo and a missing file all
 * still land on the same generic glyph, so "no icon" and "unknown icon" look
 * alike rather than one of them vanishing.
 *
 * The cast is safe and was measured: `LucideIcon` is a `ForwardRefExoticComponent`,
 * and a function component cannot take a `ref` — but no call site passes one
 * (icons that are clickable are wrapped in a `<button>`).
 */
export function lucideByName(iconName: string | null | undefined): LucideIcon {
  return flowIconComponent(iconName) as unknown as LucideIcon;
}

/**
 * True when this string names something the icon system can draw.
 *
 * Was "is it in the bespoke table"; now it is the real question, asked of the
 * registry — which is what makes it agree with `lucideByName` by construction
 * rather than by two tables happening to hold the same names.
 */
export function isCustomIconName(iconName: string | null | undefined): boolean {
  return resolveIcon(iconName, getIconPacks()).kind !== 'none';
}
