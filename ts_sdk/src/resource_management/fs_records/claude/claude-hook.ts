/**
 * ClaudeHookFsRecord — a hook definition from Claude Code settings.
 *
 * Nothing in the app imports this class: it exists to be constructed by string
 * through `fsRecordTypeRegistry`, and its registration is what lets
 * `handleDataOp` accept `claude_hook` DataOps. The backend indexes and
 * broadcasts that type (`fs_store/indexer/functions/claude_hook.py`), so
 * removing this silently drops hook record delivery.
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

fsRecordTypeRegistry.register(ClaudeHookFsRecord._recordType, ClaudeHookFsRecord as any);
