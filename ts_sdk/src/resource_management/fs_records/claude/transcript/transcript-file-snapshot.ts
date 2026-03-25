/**
 * TranscriptFileSnapshotFsRecord -- file-history-snapshot entry.
 * Mirrors Python `ClaudeFileSnapshotTranscriptEntry`.
 */
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptFileSnapshotFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_FILE_SNAPSHOT;

  get messageId(): string { return this.raw_json?.messageId as string ?? ''; }
  get snapshot(): Record<string, any> { return (this.raw_json?.snapshot as Record<string, any>) ?? {}; }
  get isSnapshotUpdate(): boolean { return (this.raw_json?.isSnapshotUpdate as boolean) ?? false; }
}

fsRecordTypeRegistry.register(TranscriptFileSnapshotFsRecord._recordType, TranscriptFileSnapshotFsRecord as any);
