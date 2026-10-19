/** What a source row's status line is made of — shared by `status-style` and `health-style`. */
import type { MessageDescriptor } from '@lingui/core';

export interface SourceLook {
  /** The words, translated where they are drawn. */
  label: MessageDescriptor;
  /** The dot's colour — the state at a glance. */
  dot: string;
  /** The words' colour; never red (see `health-style`). */
  text: string;
  /** The row's start border. */
  border: string;
}

/** A parked source: active, healthy-looking, and still never polled — said in its own words. */
export const PARKED_DOT = 'bg-red-500';
