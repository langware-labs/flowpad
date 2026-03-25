/**
 * ClaudeCommandFsRecord — a slash command from Claude Code settings.
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';

export class ClaudeCommandFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_COMMAND;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  command_name = '';
  description?: string;
  prompt?: string;
  allowed_tools?: string[];

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeCommandFsRecord._recordType, ClaudeCommandFsRecord as any);
