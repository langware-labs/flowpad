/**
 * TranscriptProgressFsRecord -- progress entry from a Claude Code session.
 * Mirrors Python `ClaudeProgressTranscriptEntry`.
 */
import { type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';
import { TranscriptEntryFsRecord } from './transcript-entry';

export class TranscriptProgressFsRecord extends TranscriptEntryFsRecord {
  static override _recordType = RecordType.TRANSCRIPT_PROGRESS;

  get progressType(): string { return this.entry_data?.type ?? ''; }
  get toolUseId(): string { return this.raw_json?.toolUseID as string ?? ''; }
  get parentToolUseId(): string { return this.raw_json?.parentToolUseID as string ?? ''; }
  get hookEvent(): string { return this.entry_data?.hookEvent ?? ''; }
  get hookName(): string { return this.entry_data?.hookName ?? ''; }
  get command(): string { return this.entry_data?.command ?? ''; }
}

fsRecordTypeRegistry.register(TranscriptProgressFsRecord._recordType, TranscriptProgressFsRecord as any);
