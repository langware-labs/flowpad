/**
 * ClaudeActiveSessionsFsRecord — list of currently running sessions.
 * ClaudeActiveSessionFsRecord — a single active session entry.
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';

export class ClaudeActiveSessionsFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_ACTIVE_SESSIONS;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FILE;

  sessions: Record<string, unknown>[] = [];

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

export class ClaudeActiveSessionFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_ACTIVE_SESSION;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  session_id = '';
  project_path?: string;
  cwd?: string;
  pid?: number;
  started_at?: string;
  model?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeActiveSessionsFsRecord._recordType, ClaudeActiveSessionsFsRecord as any);
fsRecordTypeRegistry.register(ClaudeActiveSessionFsRecord._recordType, ClaudeActiveSessionFsRecord as any);
