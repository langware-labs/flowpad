/** Shared visual contract for compact entity-header actions. */
export const compactEntityActionClassName =
  'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

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
