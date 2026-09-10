/**
 * The app's segmented control look — one definition, so every segmented control
 * stays in step when a themed ring or height changes. Consumers today: the
 * footer `ViewToggle` (mode selection) and `WebappDisplayToolbar`. Class strings
 * only — the controls have different semantics and keep their own markup.
 */

/** Container: `role="radiogroup"` row that frames the segments. */
export const SEGMENTED_GROUP =
  'flex h-6 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5';

/** One segment — pair with SEGMENTED_ACTIVE or SEGMENTED_IDLE. */
export const SEGMENTED_BUTTON = 'flex h-5 w-6 items-center justify-center rounded-sm transition-colors';

/** Selected segment. */
export const SEGMENTED_ACTIVE = 'bg-accent text-primary ring-1 ring-primary/40';

/** Unselected segment. */
export const SEGMENTED_IDLE = 'text-muted-foreground hover:bg-accent/50 hover:text-foreground';

/** A segment the control is deliberately refusing right now. Dimmed and inert —
 *  no hover affordance, because there is nothing to afford; the tooltip carries
 *  the reason. `cursor-not-allowed` rather than `pointer-events-none` so the
 *  segment still receives hover and can SHOW that tooltip: a greyed control the
 *  user cannot interrogate only moves the confusion. */
export const SEGMENTED_DISABLED = 'text-muted-foreground/40 cursor-not-allowed';
