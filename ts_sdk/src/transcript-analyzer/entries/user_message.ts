/** UserMessageEntry — a user prompt line. */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface UserMessageEntryData extends TranscriptEntryBase {
  text: string;
  /**
   * Framework-injected user line — a skill body, a slash-command expansion,
   * a Flowpad agent wrapper. The server has always sent this; mirroring it
   * lets surfaces tell "what the human sent" from "what the harness fed the
   * model" without re-sniffing the text.
   */
  is_meta?: boolean;
}

export class UserMessageEntry extends TranscriptEntry {
  override kind = EntryKind.USER_MESSAGE;

  text: string;

  is_meta: boolean;

  constructor(data: UserMessageEntryData) {
    super(data);
    this.text = data.text ?? '';
    this.is_meta = data.is_meta ?? false;
  }
}
