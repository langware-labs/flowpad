/**
 * ClaudeHistoryEntryFsRecord — a single conversation history entry.
 *
 * Fields match the Python ``ClaudeHistoryEntryFsRecord.to_dict()`` output:
 *   display, timestamp_ms, project, session_id, session_ref, _session (embedded).
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';
import type { ClaudeSessionRecordData } from './claude-session';

export class ClaudeHistoryEntryFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_HISTORY_ENTRY;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FILE;

  // Core fields from history.jsonl
  display = '';
  timestamp_ms = 0;
  project = '';
  session_id = '';

  // Session reference (set by backend)
  session_ref?: { id: string; type: string };

  // Embedded session data (present when ?include=session)
  _session?: ClaudeSessionRecordData;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeHistoryEntryFsRecord._recordType, ClaudeHistoryEntryFsRecord as any);
