/**
 * ClaudeSettingsMcpServerFsRecord — MCP server config from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeSettingsMcpServerFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_MCP_SERVER;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  server_name = '';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeSettingsMcpServerFsRecord._recordType, ClaudeSettingsMcpServerFsRecord as any);
