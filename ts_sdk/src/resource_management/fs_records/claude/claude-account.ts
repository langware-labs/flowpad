/**
 * ClaudeAccountFsRecord — legacy account record (deprecated).
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';

/** @deprecated Use ClaudeOAuthAccountFsRecord from claude-settings instead. */
export class ClaudeAccountFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_ACCOUNT;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FILE;

  account_uuid?: string;
  email?: string;
  display_name?: string;
  plan_type?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeAccountFsRecord._recordType, ClaudeAccountFsRecord as any);
