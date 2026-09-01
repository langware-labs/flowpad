/**
 * The hub-home primary card. Shared because `TokenPlanCard` renders as a
 * sibling inside the same grid as the WorldView and Organization buttons —
 * three copies of this string drift visibly, side by side, on the first
 * styling change.
 */
export const HUB_HOME_CARD =
  'group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-5 text-start transition-colors hover:bg-accent';
