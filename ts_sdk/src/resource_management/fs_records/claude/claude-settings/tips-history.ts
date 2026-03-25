/**
 * ClaudeTipsHistoryFsRecord — tips display history from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeTipsHistoryFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_TIPS_HISTORY;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  seen_tips?: string[];
  dismissed_tips?: string[];
  last_shown?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeTipsHistoryFsRecord._recordType, ClaudeTipsHistoryFsRecord as any);
