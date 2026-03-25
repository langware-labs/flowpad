/**
 * ClaudeRootFsRecord — represents a Claude Code project root directory.
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';

export class ClaudeRootFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_ROOT;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FOLDER;

  project_path?: string;
  git_remote?: string;
  git_branch?: string;
  last_session_id?: string;
  session_count = 0;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeRootFsRecord._recordType, ClaudeRootFsRecord as any);
