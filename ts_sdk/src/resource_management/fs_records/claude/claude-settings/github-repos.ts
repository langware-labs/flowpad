/**
 * ClaudeGithubReposFsRecord — GitHub repos metadata from claude settings.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeGithubReposFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_GITHUB_REPOS;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.LIST_ITEM;

  repos?: Record<string, unknown>[];
  last_fetched?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeGithubReposFsRecord._recordType, ClaudeGithubReposFsRecord as any);
