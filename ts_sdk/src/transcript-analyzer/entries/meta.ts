/**
 * MetaEntry — entries that carry no chat content.
 *
 * Catch-all for control-plane lines we recognize but don't render in the
 * chat stream: deferred-tools attachments, file-history snapshots, queue
 * ops, custom title, PR link, codex session_meta / event_msg / token_count,
 * etc. `meta_kind` carries the original type string for downstream
 * filtering.
 */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface MetaEntryData extends TranscriptEntryBase {
  meta_kind: string;
  payload?: Record<string, unknown> | null;
}

export class MetaEntry extends TranscriptEntry {
  override kind = EntryKind.META;

  meta_kind: string;
  payload: Record<string, unknown>;

  constructor(data: MetaEntryData) {
    super(data);
    this.meta_kind = data.meta_kind ?? '';
    this.payload = data.payload ?? {};
  }
}
