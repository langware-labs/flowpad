/**
 * UnknownEntry — an entry the parser couldn't classify.
 *
 * `raw_data` carries the original JSONL dict so downstream code can
 * inspect or migrate.
 */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface UnknownEntryData extends TranscriptEntryBase {
  raw_data: Record<string, unknown>;
}

export class UnknownEntry extends TranscriptEntry {
  override kind = EntryKind.UNKNOWN;

  constructor(data: UnknownEntryData) {
    super(data);
    // Force-populate raw_data — the whole point of UnknownEntry is
    // preserving the unparsed line.
    this.raw_data = data.raw_data ?? {};
  }
}
