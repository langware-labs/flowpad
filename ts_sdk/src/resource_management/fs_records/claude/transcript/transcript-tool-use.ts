/**
 * TranscriptToolUseFsRecord -- assistant entry containing a tool_use call.
 * Mirrors Python `ClaudeToolTranscriptEntry`.
 */
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptToolUseFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_TOOL_USE;

  private get _toolBlock(): Record<string, any> {
    const content = this.message?.content;
    if (!Array.isArray(content)) return {};
    for (const block of content) {
      if (typeof block === 'object' && block?.type === 'tool_use') return block;
    }
    return {};
  }

  get toolName(): string { return this._toolBlock.name ?? ''; }
  get toolUseId(): string { return this._toolBlock.id ?? ''; }
  get toolInput(): Record<string, any> { return this._toolBlock.input ?? {}; }
  get model(): string { return this.message?.model ?? ''; }
}

fsRecordTypeRegistry.register(TranscriptToolUseFsRecord._recordType, TranscriptToolUseFsRecord as any);
