/**
 * ClaudePermissionsFsRecord — permissions block from settings.json.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudePermissionsFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_JSON_PERMISSIONS;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.FILE;

  allow: string[] = [];
  ask: string[] = [];
  deny: string[] = [];
  additional_directories: string[] = [];
  default_mode = '';
  disable_bypass_permissions_mode = '';

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(
  ClaudePermissionsFsRecord._recordType,
  ClaudePermissionsFsRecord as any,
);
