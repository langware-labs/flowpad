/** SummaryEntry — auto-generated session summary. */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface SummaryEntryData extends TranscriptEntryBase {
  summary_text: string;
}

export class SummaryEntry extends TranscriptEntry {
  override kind = EntryKind.SUMMARY;

  summary_text: string;

  constructor(data: SummaryEntryData) {
    super(data);
    this.summary_text = data.summary_text ?? '';
  }
}
