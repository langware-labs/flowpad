/**
 * ClaudeHistoryFsRecord — top-level history container for a project.
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';

export class ClaudeHistoryFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_HISTORY;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FOLDER;

  project_path?: string;
  entry_count = 0;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeHistoryFsRecord._recordType, ClaudeHistoryFsRecord as any);
