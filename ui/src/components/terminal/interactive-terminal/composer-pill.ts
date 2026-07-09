/**
 * Shared base classes for the small round pills on the chat composer row
 * (the Tools-menu trigger and the Plan-mode toggle). Per-pill color/state
 * classes are appended via `cn(...)`; bottom margin/alignment is owned by the
 * composer's leadingSlot wrapper, not the pill.
 */
export const COMPOSER_PILL_CLASS =
  'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors';
