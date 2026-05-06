/** AssistantMessageEntry — an assistant text/thinking line (no tool_use). */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface AssistantMessageEntryData extends TranscriptEntryBase {
  text: string;
  thinking?: string | null;
}

export class AssistantMessageEntry extends TranscriptEntry {
  override kind = EntryKind.ASSISTANT_MESSAGE;

  text: string;
  thinking: string | null;

  constructor(data: AssistantMessageEntryData) {
    super(data);
    this.text = data.text ?? '';
    this.thinking = data.thinking ?? null;
  }
}
