/**
 * ClaudeOAuthAccountFsRecord — OAuth account info from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeOAuthAccountFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_OAUTH_ACCOUNT;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  account_uuid?: string;
  email?: string;
  display_name?: string;
  plan_type?: string;
  oauth_provider?: string;
  access_token?: string;
  refresh_token?: string;
  token_expiry?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeOAuthAccountFsRecord._recordType, ClaudeOAuthAccountFsRecord as any);
