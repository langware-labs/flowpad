/**
 * ClaudeModelUsageFsRecord — model usage statistics from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeModelUsageFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_MODEL_USAGE;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  model_id?: string;
  model_name?: string;
  request_count = 0;
  input_tokens = 0;
  output_tokens = 0;
  total_cost_usd = 0;
  last_used?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeModelUsageFsRecord._recordType, ClaudeModelUsageFsRecord as any);
