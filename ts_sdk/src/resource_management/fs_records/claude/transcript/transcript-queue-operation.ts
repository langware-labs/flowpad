/**
 * TranscriptQueueOperationFsRecord -- queue-operation entry.
 * Mirrors Python `ClaudeQueueOperationTranscriptEntry`.
 */
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptQueueOperationFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_QUEUE_OPERATION;

  get operation(): string { return this.raw_json?.operation as string ?? ''; }
  get queueContent(): string { return this.raw_json?.content as string ?? ''; }
}

fsRecordTypeRegistry.register(TranscriptQueueOperationFsRecord._recordType, TranscriptQueueOperationFsRecord as any);
