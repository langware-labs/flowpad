/** Shared visual contract for compact entity-header actions. */
export const compactEntityActionClassName =
  'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * Same contract for a bare ~12px glyph that is itself the button (the location
 * glyphs on {@link EntityIcon}). No fixed box and no hover fill — a glyph that
 * small sits inline with its neighbours and would look detached inside one.
 */
export const glyphActionClassName =
  'inline-flex shrink-0 items-center rounded transition-colors hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
