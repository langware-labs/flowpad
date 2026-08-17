/** Shared visual contract for compact entity-header actions. */
export const compactEntityActionClassName =
  'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * The same contract one size up, for WINDOW CHROME — the navigation bar's own
 * controls, which are hit at a glance rather than read inside a view.
 *
 * The glyph size rides a descendant selector on purpose: `buttonVariants` sets
 * `[&_svg]:size-4` on every `Button`, and that beats a plain `h-*` class on the
 * icon element itself (higher specificity, and twMerge can't reconcile the two
 * forms). A bare `h-[18px]` on the icon looks right in the source and does
 * nothing in the browser.
 */
export const chromeEntityActionClassName = `${compactEntityActionClassName} h-8 w-8 [&_svg]:size-[18px]`;

/**
 * The chrome size applied from a PARENT to a cluster of shared buttons it does
 * not own (the entity-actions toolbar, which keeps its compact size everywhere
 * else). Boxes only — each button keeps whatever glyph size its own contract
 * asked for, so an explicit `size={…}` prop stays honest.
 */
export const chromeActionClusterClassName = '[&_button]:h-8 [&_button]:w-8';

/**
 * A bare ~12px glyph that is itself the button (the location glyphs on
 * {@link EntityIcon}). Reads as a LINK, not a chip: no fixed box and no hover
 * fill — a glyph that small would look detached inside one — but a pointer
 * cursor, the link colour on hover, and a rule underneath it, matching the
 * "Learn about your data" treatment elsewhere.
 *
 * The bottom border is always present and merely changes colour, so hovering
 * never nudges the row's layout.
 */
export const glyphActionClassName =
  'inline-flex shrink-0 cursor-pointer items-center border-b border-transparent pb-px transition-colors hover:border-current hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
