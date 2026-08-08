import { RuntimeKind } from '@sdk';

/**
 * THE runtime→color mapping, worn by the nav bar's runtime chip.
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
 */
export const RUNTIME_CLASS: Record<RuntimeKind, string> = {
  [RuntimeKind.HUB]: 'bg-neutral-600 !text-neutral-50 dark:bg-neutral-300 dark:!text-neutral-900',
  [RuntimeKind.SANDBOX]: 'bg-blue-600 !text-white',
  [RuntimeKind.AGENT]: 'bg-purple-600 !text-white',
  [RuntimeKind.DESKTOP]: 'bg-green-600 !text-white',
  [RuntimeKind.BROWSER]: 'bg-green-700 !text-white',
};
