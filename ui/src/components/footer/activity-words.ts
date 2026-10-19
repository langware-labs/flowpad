/**
 * Display-time translation of the English words an activity arrives with.
 *
 * The backend reports a long job's label (`Indexing`, `Scanning`, …), its message
 * (`sweeping`) and its state (`running`, `failed`, …) as plain English. Known words map
 * to lazy `msg` descriptors resolved through `i18n._` at render; anything else (a QA
 * step name, a free-form message) passes through unchanged.
 */

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

const KNOWN_WORDS: Record<string, MessageDescriptor> = {
  // Job labels (flow_sdk/activity/bridge.py _JOB_LABELS).
  Indexing: msg`Indexing`,
  Scanning: msg`Scanning`,
  'Clearing index': msg`Clearing index`,
  Archiving: msg`Archiving`,
  Restoring: msg`Restoring`,
  Working: msg`Working`,
  // Progress messages the indexer emits.
  sweeping: msg`sweeping`,
  complete: msg`complete`,
  // Activity states (ActivityState).
  pending: msg`pending`,
  running: msg`running`,
  paused: msg`paused`,
  blocked: msg`blocked`,
  completed: msg`completed`,
  done: msg`done`,
  failed: msg`failed`,
  cancelled: msg`cancelled`,
  interrupted: msg`interrupted`,
};

/** The word in the current locale if it is one we know, else the word itself. */
export function activityWord(word: string): string {
  const descriptor = Object.prototype.hasOwnProperty.call(KNOWN_WORDS, word) ? KNOWN_WORDS[word] : undefined;
  return descriptor ? i18n._(descriptor) : word;
}
