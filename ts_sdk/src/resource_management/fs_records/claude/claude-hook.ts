/**
 * ClaudeHookFsRecord — a hook definition from Claude Code settings.
 * ClaudeHookEntryFsRecord — a single entry within a hook's entries list.
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';

export class ClaudeHookFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_HOOK;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  event_type = '';
  matcher?: string;
  command?: string;
  hook_type = 'command';
  enabled = true;
  plugin_name?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

export class ClaudeHookEntryFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_HOOK_ENTRY;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  event_type = '';
  matcher = '*';
  hooks: Record<string, unknown>[] = [];

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeHookFsRecord._recordType, ClaudeHookFsRecord as any);
fsRecordTypeRegistry.register(ClaudeHookEntryFsRecord._recordType, ClaudeHookEntryFsRecord as any);
