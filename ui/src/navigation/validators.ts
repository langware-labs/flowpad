import { VIEW_SLOTS, ViewSlot, ViewType } from '../types/ViewType';

/**
 * Validate view slot string
 */
export function isValidViewSlot(slot: string): slot is ViewSlot {
  return Object.values(VIEW_SLOTS).includes(slot as ViewSlot);
}

/**
 * Validate pointer for a given view type
 */
export function isValidView(viewType: string): boolean {
  return Object.values(ViewType).includes(viewType as ViewType);
}
