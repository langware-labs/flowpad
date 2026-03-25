/**
 * ClaudeSkillUsageFsRecord — skill usage tracking from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeSkillUsageFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_SKILL_USAGE;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  skill_name?: string;
  use_count = 0;
  last_used?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeSkillUsageFsRecord._recordType, ClaudeSkillUsageFsRecord as any);
