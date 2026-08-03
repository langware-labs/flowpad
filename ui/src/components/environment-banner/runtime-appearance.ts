import { RuntimeKind } from '@sdk';

/**
 * THE runtime→color mapping. One table, both surfaces: the banner strip and the
 * rail's Home icon, which carries the color once the banner is minimized.
 *
 * One table rather than two because the minimized icon IS the banner, shrunk —
 * a second copy could drift into closing one color into a different one. It is
 * also not *derived* from a banner-only table at runtime: Tailwind scans source
 * text, so a class assembled by string surgery is never emitted into the CSS
 * and the tint would silently render unstyled.
 *
 * `!` on the foreground for the rail's sake: the rail button sets its own text
 * color for active/hover and would otherwise win at equal specificity, leaving
 * a near-black glyph on `green-700`. Nothing competes on the banner, so the
 * same class renders identically there.
 *
 * `hub` is contrast-flipped per theme so it reads as neutral chrome in both;
 * `desktop` and `browser` are two shades of one green because they are the same
 * machine seen by two clients; the cloud kinds are deliberately loud.
 */
export const RUNTIME_CLASS: Record<RuntimeKind, string> = {
  [RuntimeKind.HUB]: 'bg-neutral-600 !text-neutral-50 dark:bg-neutral-300 dark:!text-neutral-900',
  [RuntimeKind.SANDBOX]: 'bg-blue-600 !text-white',
  [RuntimeKind.AGENT]: 'bg-purple-600 !text-white',
  [RuntimeKind.DESKTOP]: 'bg-green-600 !text-white',
  [RuntimeKind.BROWSER]: 'bg-green-700 !text-white',
};
