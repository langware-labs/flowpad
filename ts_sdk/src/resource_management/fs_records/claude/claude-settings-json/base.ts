/**
 * ClaudeSettingsJsonFsRecord — root record from settings.json.
 * Writable — these are user-editable configuration files.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeSettingsJsonFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_JSON;
  static override _readOnly = false;
  static override _storageLayout = StorageLayout.FILE;

  // Model configuration
  model = '';
  available_models: string[] = [];
  always_thinking_enabled = false;

  // Auth & API
  api_key_helper = '';
  force_login_method = '';
  force_login_org_uuid = '';

  // MCP control
  enable_all_project_mcp_servers = false;
  enabled_mcpjson_servers: string[] = [];
  disabled_mcpjson_servers: string[] = [];

  // Hooks
  hooks: Record<string, unknown[]> = {};
  disable_all_hooks = false;

  // Output & Display
  output_style = '';
  language = '';
  show_turn_duration = false;
  spinner_verbs: Record<string, unknown> = {};
  spinner_tips_enabled = false;
  spinner_tips_override: Record<string, unknown> = {};
  terminal_progress_bar_enabled = false;
  prefers_reduced_motion = false;

  // Files & directories
  file_suggestion: Record<string, unknown> = {};
  respect_gitignore = true;
  plans_directory = '';

  // Environment & updates
  env: Record<string, string> = {};
  auto_updates_channel = '';

  // Session & lifecycle
  cleanup_period_days = 0;
  status_line: Record<string, unknown> = {};

  // Plugins & marketplaces
  enabled_plugins: Record<string, boolean> = {};
  extra_known_marketplaces: Record<string, unknown> = {};

  // Cloud providers
  aws_auth_refresh = '';
  aws_credential_export = '';

  // Monitoring
  otel_headers_helper = '';

  // Teams
  teammate_mode = '';

  // Company
  company_announcements: string[] = [];

  // Deprecated
  include_co_authored_by = true;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(
  ClaudeSettingsJsonFsRecord._recordType,
  ClaudeSettingsJsonFsRecord as any,
);
