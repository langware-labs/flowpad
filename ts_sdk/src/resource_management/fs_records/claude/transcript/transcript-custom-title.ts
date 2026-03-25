/**
 * TranscriptCustomTitleFsRecord -- custom-title entry.
 * Mirrors Python `ClaudeCustomTitleTranscriptEntry`.
 */
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptCustomTitleFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_CUSTOM_TITLE;

  get customTitle(): string { return this.raw_json?.customTitle as string ?? ''; }
}

fsRecordTypeRegistry.register(TranscriptCustomTitleFsRecord._recordType, TranscriptCustomTitleFsRecord as any);
