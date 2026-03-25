/**
 * TranscriptToolResultFsRecord -- user entry containing a tool_result.
 * Mirrors Python `ClaudeToolResultTranscriptEntry`.
 */
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptToolResultFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_TOOL_RESULT;

  private get _resultBlock(): Record<string, any> {
    const content = this.message?.content;
    if (!Array.isArray(content)) return {};
    for (const block of content) {
      if (typeof block === 'object' && block?.type === 'tool_result') return block;
    }
    return {};
  }

  get toolUseId(): string { return this._resultBlock.tool_use_id ?? ''; }

  get content(): string {
    const raw = this._resultBlock.content ?? '';
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
      return raw
        .filter((b: any) => typeof b === 'object' && b?.type === 'text')
        .map((b: any) => b.text ?? '')
        .join('\n');
    }
    return String(raw);
  }

  get isError(): boolean { return this._resultBlock.is_error ?? false; }
  get filePath(): string { return (this.raw_json?.toolUseResult as any)?.filePath ?? ''; }
}

fsRecordTypeRegistry.register(TranscriptToolResultFsRecord._recordType, TranscriptToolResultFsRecord as any);
