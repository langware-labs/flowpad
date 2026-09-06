import { Bot, CloudUpload, Globe, Monitor, type LucideIcon } from 'lucide-react';
import { RuntimeKind } from '@sdk';

/**
 * THE per-runtime appearance, worn by the nav bar's runtime chip: its color,
 * its glyph, and the heading of the "Runtime environments" wiki page that
 * explains it. One table, so a new runtime kind fails to typecheck until every
 * fact is filled in — no per-table fallback can quietly dress it as a desktop.
 *
 * The classes are spelled as literals and must stay that way: Tailwind scans
 * source text, so a class assembled by string surgery is never emitted into the
 * CSS and the chip would silently render unstyled. A unit test asserts every
 * token appears verbatim in this file for exactly that reason.
 *
 * `!` on the foreground: the chip is a button, and a host that sets its own
 * text color for hover/active would otherwise win at equal specificity and
 * leave a near-black glyph on `green-700`. It costs nothing where nothing
 * competes.
 *
 * `hub` is contrast-flipped per theme so it reads as neutral chrome in both;
 * `desktop` and `browser` are two shades of one green because they are the same
 * machine seen by two clients; the cloud kinds are deliberately loud.
 *
 * Glyphs describe RUNTIMES, not entity types — there is no TypeInfo for "a
 * cloud sandbox", so `iconForType` has nothing to resolve. The cloud kinds wear
 * the same glyph as the "Link to cloud" buttons; a local browser is the desktop
 * machine seen through a browser tab, so it is the desktop glyph badged with a
 * browser rather than a globe of its own.
 *
 * `heading` is the section's TITLE as written in the wiki page; the chip slugs
 * it with `gfmSlug` to deep-link. The text, not the slug, is what a doc editor
 * sees and greps for.
 */
export interface RuntimeAppearance {
  className: string;
  base: LucideIcon;
  badge?: LucideIcon;
  heading: string;
}

export const RUNTIME_APPEARANCE: Record<RuntimeKind, RuntimeAppearance> = {
  [RuntimeKind.HUB]: {
    className: 'bg-neutral-600 !text-neutral-50 dark:bg-neutral-300 dark:!text-neutral-900',
    base: CloudUpload,
    heading: 'Hub — grey banner',
  },
  [RuntimeKind.SANDBOX]: {
    className: 'bg-blue-600 !text-white',
    base: CloudUpload,
    heading: 'Cloud Sandbox — blue banner',
  },
  [RuntimeKind.AGENT]: {
    className: 'bg-purple-600 !text-white',
    base: Bot,
    heading: 'Agent — purple banner',
  },
  [RuntimeKind.DESKTOP]: {
    className: 'bg-green-600 !text-white',
    base: Monitor,
    heading: 'Desktop — green banner',
  },
  [RuntimeKind.BROWSER]: {
    className: 'bg-green-700 !text-white',
    base: Monitor,
    badge: Globe,
    heading: 'Local Browser — green banner',
  },
};

/** The runtime→color slice of the table, for surfaces that only need the tint. */
export const RUNTIME_CLASS: Record<RuntimeKind, string> = Object.fromEntries(
  Object.entries(RUNTIME_APPEARANCE).map(([kind, a]) => [kind, a.className]),
) as Record<RuntimeKind, string>;
