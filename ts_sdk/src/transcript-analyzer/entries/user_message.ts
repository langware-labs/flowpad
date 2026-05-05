/** UserMessageEntry — a user prompt line. */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface UserMessageEntryData extends TranscriptEntryBase {
  text: string;
}

export class UserMessageEntry extends TranscriptEntry {
  override kind = EntryKind.USER_MESSAGE;

  text: string;

  constructor(data: UserMessageEntryData) {
    super(data);
    this.text = data.text ?? '';
  }
}
