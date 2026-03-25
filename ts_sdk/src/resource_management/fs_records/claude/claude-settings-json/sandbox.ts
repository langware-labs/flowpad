/**
 * ClaudeSandboxFsRecord — sandbox block from settings.json.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeSandboxFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_JSON_SANDBOX;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.FILE;

  enabled = false;
  auto_allow_bash_if_sandboxed = false;
  excluded_commands: string[] = [];
  allow_unsandboxed_commands = false;
  enable_weaker_nested_sandbox = false;

  // Network sub-block (flattened)
  network_allowed_domains: string[] = [];
  network_allow_unix_sockets: string[] = [];
  network_allow_all_unix_sockets = false;
  network_allow_local_binding = false;
  network_http_proxy_port = 0;
  network_socks_proxy_port = 0;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(
  ClaudeSandboxFsRecord._recordType,
  ClaudeSandboxFsRecord as any,
);
