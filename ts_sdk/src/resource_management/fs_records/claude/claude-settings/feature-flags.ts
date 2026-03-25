/**
 * ClaudeFeatureFlagsFsRecord — feature flags from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeFeatureFlagsFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_FEATURE_FLAGS;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  flags?: Record<string, boolean>;
  last_fetched?: string;
  source?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeFeatureFlagsFsRecord._recordType, ClaudeFeatureFlagsFsRecord as any);
