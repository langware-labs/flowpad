/**
 * Close-in-place (Chrome's tab-close mode).
 *
 * Closing a tab with the mouse freezes every remaining tab at the width it had,
 * so the next tab's close button slides under the cursor and the user can keep
 * clicking the same spot. Closing the LAST tab adds a lead spacer of one tab
 * stride instead, so the tabs shift toward the cursor — only when the tabs are
 * shrunk; at full width the row has free space and nothing would move. The strip goes back to
 * normal widths when the pointer leaves it, the tab list changes any other way,
 * the strip resizes, or nothing has been closed for a few seconds.
 *
 * Pure: the reducer and the sizing helper never touch the DOM.
 */
import type React from 'react';

/** How long the pointer must stay out of the strip before the tabs resize. */
export const FREEZE_LEAVE_DELAY_MS = 250;
/** With no further close, the tabs resize after this long even if the pointer stays. */
export const FREEZE_IDLE_MS = 3000;
/** Width of the separator between two tabs (`w-px` in TabStrip). */
export const SEPARATOR_PX = 1;

export interface FreezeState {
  /** The width every tab is held at; null = normal flex layout. */
  frozenPx: number | null;
  /** Width of the spacer before the first tab (grows as tabs close from the end). */
  leadPad: number;
}

export type FreezeEvent =
  | {
      type: 'closeByMouse';
      /** The clicked tab's rendered width. */
      tabPx: number;
      /** The tabs' full width; a tab at it means the row has free space after it. */
      maxPx: number;
      /** Where the clicked tab sits in the row. */
      index: number;
      count: number;
    }
  | { type: 'release' };

export const FREEZE_IDLE: FreezeState = { frozenPx: null, leadPad: 0 };

export function freezeReducer(state: FreezeState, event: FreezeEvent): FreezeState {
  if (event.type === 'release') {
    return state.frozenPx === null && state.leadPad === 0 ? state : FREEZE_IDLE;
  }
  // A close while already frozen keeps the first width, so the stride never drifts.
  const frozenPx = state.frozenPx ?? event.tabPx;
  const wasLast = event.index === event.count - 1;
  // Tabs at full width (0.5px slack for sub-pixel widths) never grow, so closing the last one needs no spacer.
  const shrunk = frozenPx < event.maxPx - 0.5;
  // The last tab takes its separator with it (the first tab has none).
  const stride = frozenPx + (event.index > 0 ? SEPARATOR_PX : 0);
  return { frozenPx, leadPad: wasLast && shrunk ? state.leadPad + stride : state.leadPad };
}

/** The inline style of one tab. */
export function chipSizing(
  frozenPx: number | null,
  isEditing: boolean,
  limits: { maxPx: number; minPx: number },
): React.CSSProperties {
  if (isEditing) return { width: limits.maxPx, flex: 'none' };
  if (frozenPx !== null) return { flex: `0 0 ${frozenPx}px`, minWidth: frozenPx, maxWidth: frozenPx };
  return { flex: `1 1 ${limits.maxPx}px`, minWidth: limits.minPx, maxWidth: limits.maxPx };
}
