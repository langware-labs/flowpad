/**
 * ClaudeMcpServerFsRecord — an MCP server entry from Claude Code settings.
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';

export class ClaudeMcpServerFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_MCP_SERVER;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  server_name = '';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled = true;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeMcpServerFsRecord._recordType, ClaudeMcpServerFsRecord as any);
