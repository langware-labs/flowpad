import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Canonical "de-emphasize a rail row that has no open tab" treatment: dimmed at
 *  rest, full brightness on hover. Shared so every navigator rail (BrowseableTree
 *  rows, Chats rows, future custom rails) reads the same dim spec. */
export const RAIL_DIM_WHEN_CLOSED = 'opacity-60 hover:opacity-100';
