/**
 * TranscriptEntryFsRecord -- base entry from a Claude Code session JSONL.
 * Mirrors Python `ClaudeTranscriptEntryFsRecord` in
 * `flow_sdk/fs_records/claude/transcript_records/base.py`.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export interface TranscriptEntryData {
  entry_type: string;
  entry_uuid: string;
  timestamp: string;
  session_id: string;
  subtype?: string;
  parent_uuid?: string;
  is_sidechain?: boolean;
  message?: {
    content?: any;
    model?: string;
    stop_reason?: string;
    usage?: Record<string, number>;
  };
  data?: Record<string, any>;
}

export class TranscriptEntryFsRecord extends FsRecord {
  static override _recordType = RecordType.TRANSCRIPT_ENTRY;
  static override _readOnly = true;

  entry_type = '';
  entry_uuid = '';
  timestamp = '';
  session_id = '';
  subtype?: string;
  parent_uuid?: string;
  is_sidechain?: boolean;
  message?: TranscriptEntryData['message'];
  // `data` conflicts with FsRecord -- use `entry_data` instead
  entry_data?: Record<string, any>;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
    // Map `data` field from raw JSON to `entry_data` to avoid FsRecord.data conflict
    if (data && 'data' in data && !('entry_data' in data)) {
      this.entry_data = data.data as Record<string, any>;
    }
  }

  get summary(): string {
    return `[${this.entry_type}] ${this.entry_uuid}`;
  }

  static fromTranscriptData(raw: TranscriptEntryData): TranscriptEntryFsRecord {
    return new TranscriptEntryFsRecord(raw as unknown as Partial<FsRecordData>);
  }
}

fsRecordTypeRegistry.register(TranscriptEntryFsRecord._recordType, TranscriptEntryFsRecord as any);
