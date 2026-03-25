/**
 * ClaudeProjectEntryFsRecord — a project entry from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeProjectEntryFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_PROJECT_ENTRY;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  project_path?: string;
  encoded_name?: string;
  last_opened?: string;
  session_count = 0;
  total_cost_usd = 0;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeProjectEntryFsRecord._recordType, ClaudeProjectEntryFsRecord as any);
