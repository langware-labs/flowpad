/**
 * ClaudeAttributionFsRecord — attribution block from settings.json.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeAttributionFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_JSON_ATTRIBUTION;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.FILE;

  commit = '';
  pr = '';

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(
  ClaudeAttributionFsRecord._recordType,
  ClaudeAttributionFsRecord as any,
);
