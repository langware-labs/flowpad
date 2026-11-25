// The round mark the Stream Inbox's channel row is made of: a channel, attached or still to connect, and the
// row's own buttons. The glyph is its first child — an svg, or the <img>/<span> a brand mark renders as.
export const MARK =
  'relative grid size-8 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';
// The mark a filter picked: a 2px primary ring with a soft halo, so it reads at a glance.
export const MARK_SELECTED = 'border-2 border-primary ring-[3px] ring-primary/25';
export const MARK_BADGE = 'absolute -bottom-0.5 -end-0.5 rounded-full border-2 border-background';
// A tool of the row (warnings, the tag filter) — not a channel, so not a circle.
export const MARK_TOOL = 'rounded-lg';
// What parts the row's tools from its channels.
export const MARK_DIVIDER = 'mx-1 h-5 w-px shrink-0 bg-border';
