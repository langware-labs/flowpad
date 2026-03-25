/**
 * TranscriptSummaryFsRecord -- summary entry.
 * Mirrors Python `ClaudeSummaryTranscriptEntry`.
 */
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptSummaryFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_SUMMARY;

  get leafUuid(): string { return this.raw_json?.leafUuid as string ?? ''; }
  get summaryText(): string { return this.raw_json?.summary as string ?? ''; }
}

fsRecordTypeRegistry.register(TranscriptSummaryFsRecord._recordType, TranscriptSummaryFsRecord as any);
