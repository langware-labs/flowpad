/**
 * TranscriptPrLinkFsRecord -- pr-link entry.
 * Mirrors Python `ClaudePrLinkTranscriptEntry`.
 */
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptPrLinkFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_PR_LINK;

  get prNumber(): number { return (this.raw_json?.prNumber as number) ?? 0; }
  get prUrl(): string { return this.raw_json?.prUrl as string ?? ''; }
  get prRepository(): string { return this.raw_json?.prRepository as string ?? ''; }
}

fsRecordTypeRegistry.register(TranscriptPrLinkFsRecord._recordType, TranscriptPrLinkFsRecord as any);
