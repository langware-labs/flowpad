import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ClaudeSettingsJsonRecordList } from '@sdk';

// ── Types ───────────────────────────────────────────────

export type FieldType = 'string' | 'boolean' | 'number' | 'string[]' | 'dict' | 'object';
export type Scope = 'default' | 'user' | 'project' | 'local';

export interface SettingsField {
  key: string;
  label: string;
  category: string;
  fieldType: FieldType;
  effectiveValue: unknown;
  scope: Scope;
  userValue?: unknown;
  projectValue?: unknown;
  localValue?: unknown;
  jsonPath: string;
  recordType: string;
  description?: string;
  allowedValues?: string[];
}

// ── Field Definition Registry ───────────────────────────

interface FieldDef {
  key: string;
  /** Lazy descriptors, resolved in `buildSettingsFields`. This table is
   *  module-level, so an eager `t` would bind the language at import. */
  label: MessageDescriptor;
  category: string;
  fieldType: FieldType;
  /** Which sub-record this field lives in: 'root' | 'permissions' | 'sandbox' | 'attribution' */
  record: 'root' | 'permissions' | 'sandbox' | 'attribution';
  /** The snake_case property name on the FsRecord class */
  recordKey: string;
  description?: MessageDescriptor;
  allowedValues?: string[];
}

const FIELD_DEFS: FieldDef[] = [
  // ── Model & Performance ──────────────────────────────
  {
    key: 'model',
    label: msg`Model`,
    category: 'Model & Performance',
    fieldType: 'string',
    record: 'root',
    recordKey: 'model',
    description: msg`Default model to use for conversations`,
  },
  {
    key: 'availableModels',
    label: msg`Available Models`,
    category: 'Model & Performance',
    fieldType: 'string[]',
    record: 'root',
    recordKey: 'available_models',
    description: msg`List of models available for selection`,
  },
  {
    key: 'alwaysThinkingEnabled',
    label: msg`Always Thinking Enabled`,
    category: 'Model & Performance',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'always_thinking_enabled',
    description: msg`Enable extended thinking for all conversations`,
  },
  {
    key: 'outputStyle',
    label: msg`Output Style`,
    category: 'Model & Performance',
    fieldType: 'string',
    record: 'root',
    recordKey: 'output_style',
    description: msg`Default output style`,
    allowedValues: ['concise', 'verbose', 'normal'],
  },

  // ── Permissions ──────────────────────────────────────
  {
    key: 'permissions.allow',
    label: msg`Allow`,
    category: 'Permissions',
    fieldType: 'string[]',
    record: 'permissions',
    recordKey: 'allow',
    description: msg`Tool patterns allowed without prompting`,
  },
  {
    key: 'permissions.ask',
    label: msg`Ask`,
    category: 'Permissions',
    fieldType: 'string[]',
    record: 'permissions',
    recordKey: 'ask',
    description: msg`Tool patterns that require confirmation`,
  },
  {
    key: 'permissions.deny',
    label: msg`Deny`,
    category: 'Permissions',
    fieldType: 'string[]',
    record: 'permissions',
    recordKey: 'deny',
    description: msg`Tool patterns that are always denied`,
  },
  {
    key: 'permissions.additionalDirectories',
    label: msg`Additional Directories`,
    category: 'Permissions',
    fieldType: 'string[]',
    record: 'permissions',
    recordKey: 'additional_directories',
    description: msg`Extra directories Claude can access`,
  },
  {
    key: 'permissions.defaultMode',
    label: msg`Default Mode`,
    category: 'Permissions',
    fieldType: 'string',
    record: 'permissions',
    recordKey: 'default_mode',
    description: msg`Default permission mode`,
    allowedValues: ['default', 'plan', 'bypassPermissions'],
  },
  {
    key: 'permissions.disableBypassPermissionsMode',
    label: msg`Disable Bypass Permissions Mode`,
    category: 'Permissions',
    fieldType: 'string',
    record: 'permissions',
    recordKey: 'disable_bypass_permissions_mode',
    description: msg`Prevent use of bypass permissions mode`,
  },

  // ── Sandbox ──────────────────────────────────────────
  {
    key: 'sandbox.enabled',
    label: msg`Sandbox Enabled`,
    category: 'Sandbox',
    fieldType: 'boolean',
    record: 'sandbox',
    recordKey: 'enabled',
    description: msg`Enable command sandboxing`,
  },
  {
    key: 'sandbox.autoAllowBashIfSandboxed',
    label: msg`Auto-allow Bash if Sandboxed`,
    category: 'Sandbox',
    fieldType: 'boolean',
    record: 'sandbox',
    recordKey: 'auto_allow_bash_if_sandboxed',
    description: msg`Auto-approve bash when sandbox is active`,
  },
  {
    key: 'sandbox.excludedCommands',
    label: msg`Excluded Commands`,
    category: 'Sandbox',
    fieldType: 'string[]',
    record: 'sandbox',
    recordKey: 'excluded_commands',
    description: msg`Commands excluded from sandboxing`,
  },
  {
    key: 'sandbox.allowUnsandboxedCommands',
    label: msg`Allow Unsandboxed Commands`,
    category: 'Sandbox',
    fieldType: 'boolean',
    record: 'sandbox',
    recordKey: 'allow_unsandboxed_commands',
    description: msg`Allow commands to run outside sandbox`,
  },
  {
    key: 'sandbox.enableWeakerNestedSandbox',
    label: msg`Enable Weaker Nested Sandbox`,
    category: 'Sandbox',
    fieldType: 'boolean',
    record: 'sandbox',
    recordKey: 'enable_weaker_nested_sandbox',
    description: msg`Use weaker sandbox for nested commands`,
  },
  {
    key: 'sandbox.network.allowedDomains',
    label: msg`Allowed Domains`,
    category: 'Sandbox',
    fieldType: 'string[]',
    record: 'sandbox',
    recordKey: 'network_allowed_domains',
    description: msg`Domains accessible from sandbox`,
  },
  {
    key: 'sandbox.network.allowUnixSockets',
    label: msg`Allow Unix Sockets`,
    category: 'Sandbox',
    fieldType: 'string[]',
    record: 'sandbox',
    recordKey: 'network_allow_unix_sockets',
    description: msg`Specific unix sockets allowed in sandbox`,
  },
  {
    key: 'sandbox.network.allowAllUnixSockets',
    label: msg`Allow All Unix Sockets`,
    category: 'Sandbox',
    fieldType: 'boolean',
    record: 'sandbox',
    recordKey: 'network_allow_all_unix_sockets',
    description: msg`Allow all unix socket connections`,
  },
  {
    key: 'sandbox.network.allowLocalBinding',
    label: msg`Allow Local Binding`,
    category: 'Sandbox',
    fieldType: 'boolean',
    record: 'sandbox',
    recordKey: 'network_allow_local_binding',
    description: msg`Allow binding to local ports`,
  },
  {
    key: 'sandbox.network.httpProxyPort',
    label: msg`HTTP Proxy Port`,
    category: 'Sandbox',
    fieldType: 'number',
    record: 'sandbox',
    recordKey: 'network_http_proxy_port',
    description: msg`Port for HTTP proxy in sandbox`,
  },
  {
    key: 'sandbox.network.socksProxyPort',
    label: msg`SOCKS Proxy Port`,
    category: 'Sandbox',
    fieldType: 'number',
    record: 'sandbox',
    recordKey: 'network_socks_proxy_port',
    description: msg`Port for SOCKS proxy in sandbox`,
  },

  // ── Authentication ───────────────────────────────────
  {
    key: 'apiKeyHelper',
    label: msg`API Key Helper`,
    category: 'Authentication',
    fieldType: 'string',
    record: 'root',
    recordKey: 'api_key_helper',
    description: msg`Command to retrieve API key dynamically`,
  },
  {
    key: 'forceLoginMethod',
    label: msg`Force Login Method`,
    category: 'Authentication',
    fieldType: 'string',
    record: 'root',
    recordKey: 'force_login_method',
    description: msg`Force a specific authentication method`,
  },
  {
    key: 'forceLoginOrgUUID',
    label: msg`Force Login Org UUID`,
    category: 'Authentication',
    fieldType: 'string',
    record: 'root',
    recordKey: 'force_login_org_uuid',
    description: msg`Force login to a specific organization`,
  },
  {
    key: 'awsAuthRefresh',
    label: msg`AWS Auth Refresh`,
    category: 'Authentication',
    fieldType: 'string',
    record: 'root',
    recordKey: 'aws_auth_refresh',
    description: msg`Command to refresh AWS credentials`,
  },
  {
    key: 'awsCredentialExport',
    label: msg`AWS Credential Export`,
    category: 'Authentication',
    fieldType: 'string',
    record: 'root',
    recordKey: 'aws_credential_export',
    description: msg`Command to export AWS credentials`,
  },

  // ── Environment (dict) ─────────────────────────────────
  {
    key: 'env',
    label: msg`Environment Variables`,
    category: 'Environment',
    fieldType: 'dict',
    record: 'root',
    recordKey: 'env',
    description: msg`Full environment variable dictionary`,
  },

  // ── Environment (individual vars) ──────────────────────
  {
    key: 'env.ANTHROPIC_API_KEY',
    label: msg`API Key`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.ANTHROPIC_API_KEY',
    description: msg`Anthropic API key for direct API access`,
  },
  {
    key: 'env.ANTHROPIC_MODEL',
    label: msg`Model Override`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.ANTHROPIC_MODEL',
    description: msg`Override the default model via environment`,
  },
  {
    key: 'env.CLAUDE_CODE_MAX_TURNS',
    label: msg`Max Turns`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_MAX_TURNS',
    description: msg`Maximum number of agentic turns`,
  },
  {
    key: 'env.CLAUDE_CODE_USE_BEDROCK',
    label: msg`Use Bedrock`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_USE_BEDROCK',
    description: msg`Use AWS Bedrock as the backend`,
    allowedValues: ['0', '1'],
  },
  {
    key: 'env.CLAUDE_CODE_USE_VERTEX',
    label: msg`Use Vertex`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_USE_VERTEX',
    description: msg`Use Google Vertex AI as the backend`,
    allowedValues: ['0', '1'],
  },
  {
    key: 'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    label: msg`Disable Non-essential Traffic`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    description: msg`Disable telemetry and analytics`,
    allowedValues: ['0', '1'],
  },
  {
    key: 'env.ANTHROPIC_BASE_URL',
    label: msg`Base URL`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.ANTHROPIC_BASE_URL',
    description: msg`Custom API base URL for Anthropic`,
  },
  {
    key: 'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    label: msg`Max Output Tokens`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    description: msg`Maximum tokens per model response`,
  },
  {
    key: 'env.HTTP_PROXY',
    label: msg`HTTP Proxy`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.HTTP_PROXY',
    description: msg`HTTP proxy URL for network requests`,
  },
  {
    key: 'env.HTTPS_PROXY',
    label: msg`HTTPS Proxy`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.HTTPS_PROXY',
    description: msg`HTTPS proxy URL for network requests`,
  },
  {
    key: 'env.CLAUDE_CODE_SKIP_PERMISSIONS_WARMUP',
    label: msg`Skip Permissions Warmup`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_SKIP_PERMISSIONS_WARMUP',
    description: msg`Skip initial permission check on startup`,
    allowedValues: ['0', '1'],
  },
  {
    key: 'env.BASH_DEFAULT_TIMEOUT_MS',
    label: msg`Bash Timeout (ms)`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.BASH_DEFAULT_TIMEOUT_MS',
    description: msg`Default bash command timeout in milliseconds`,
  },
  {
    key: 'env.AWS_REGION',
    label: msg`AWS Region`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.AWS_REGION',
    description: msg`AWS region for Bedrock`,
  },
  {
    key: 'env.AWS_PROFILE',
    label: msg`AWS Profile`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.AWS_PROFILE',
    description: msg`AWS CLI profile name`,
  },
  {
    key: 'env.CLOUD_ML_REGION',
    label: msg`Vertex Region`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLOUD_ML_REGION',
    description: msg`GCP region for Vertex AI`,
  },
  {
    key: 'env.ANTHROPIC_VERTEX_PROJECT_ID',
    label: msg`Vertex Project ID`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.ANTHROPIC_VERTEX_PROJECT_ID',
    description: msg`GCP project ID for Vertex AI`,
  },
  {
    key: 'env.CLAUDE_CODE_ANTHROPIC_TIMEOUT',
    label: msg`API Timeout`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_ANTHROPIC_TIMEOUT',
    description: msg`Timeout for Anthropic API calls in ms`,
  },
  {
    key: 'env.CLAUDE_CODE_MAX_MEMORY',
    label: msg`Max Memory`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_MAX_MEMORY',
    description: msg`Maximum memory usage limit`,
  },
  {
    key: 'env.DISABLE_PROMPT_CACHING',
    label: msg`Disable Prompt Caching`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.DISABLE_PROMPT_CACHING',
    description: msg`Disable API prompt caching`,
    allowedValues: ['0', '1'],
  },
  {
    key: 'env.CLAUDE_CODE_REASONING_EFFORT',
    label: msg`Reasoning Effort`,
    category: 'Environment',
    fieldType: 'string',
    record: 'root',
    recordKey: 'env.CLAUDE_CODE_REASONING_EFFORT',
    description: msg`Control reasoning effort level`,
    allowedValues: ['low', 'medium', 'high'],
  },

  // ── Hooks ────────────────────────────────────────────
  {
    key: 'hooks',
    label: msg`Hooks`,
    category: 'Hooks',
    fieldType: 'object',
    record: 'root',
    recordKey: 'hooks',
    description: msg`Shell commands triggered by tool events`,
  },
  {
    key: 'disableAllHooks',
    label: msg`Disable All Hooks`,
    category: 'Hooks',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'disable_all_hooks',
    description: msg`Disable all hook execution`,
  },

  // ── Files & Directories ──────────────────────────────
  {
    key: 'respectGitignore',
    label: msg`Respect Gitignore`,
    category: 'Files & Directories',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'respect_gitignore',
    description: msg`Respect .gitignore when searching files`,
  },
  {
    key: 'fileSuggestion',
    label: msg`File Suggestion`,
    category: 'Files & Directories',
    fieldType: 'object',
    record: 'root',
    recordKey: 'file_suggestion',
    description: msg`File suggestion configuration`,
  },
  {
    key: 'plansDirectory',
    label: msg`Plans Directory`,
    category: 'Files & Directories',
    fieldType: 'string',
    record: 'root',
    recordKey: 'plans_directory',
    description: msg`Directory for saving plan files`,
  },

  // ── UI & Display ─────────────────────────────────────
  {
    key: 'language',
    label: msg`Language`,
    category: 'UI & Display',
    fieldType: 'string',
    record: 'root',
    recordKey: 'language',
    description: msg`Preferred language for responses`,
  },
  {
    key: 'showTurnDuration',
    label: msg`Show Turn Duration`,
    category: 'UI & Display',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'show_turn_duration',
    description: msg`Show timing info for each turn`,
  },
  {
    key: 'spinnerVerbs',
    label: msg`Spinner Verbs`,
    category: 'UI & Display',
    fieldType: 'object',
    record: 'root',
    recordKey: 'spinner_verbs',
    description: msg`Custom verbs for the progress spinner`,
  },
  {
    key: 'spinnerTipsEnabled',
    label: msg`Spinner Tips Enabled`,
    category: 'UI & Display',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'spinner_tips_enabled',
    description: msg`Show tips while spinner is active`,
  },
  {
    key: 'spinnerTipsOverride',
    label: msg`Spinner Tips Override`,
    category: 'UI & Display',
    fieldType: 'object',
    record: 'root',
    recordKey: 'spinner_tips_override',
    description: msg`Custom tip content for the spinner`,
  },
  {
    key: 'terminalProgressBarEnabled',
    label: msg`Terminal Progress Bar Enabled`,
    category: 'UI & Display',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'terminal_progress_bar_enabled',
    description: msg`Show a progress bar in the terminal`,
  },
  {
    key: 'prefersReducedMotion',
    label: msg`Prefers Reduced Motion`,
    category: 'UI & Display',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'prefers_reduced_motion',
    description: msg`Reduce animations and motion effects`,
  },
  {
    key: 'statusLine',
    label: msg`Status Line`,
    category: 'UI & Display',
    fieldType: 'object',
    record: 'root',
    recordKey: 'status_line',
    description: msg`Status line display configuration`,
  },

  // ── MCP Servers ──────────────────────────────────────
  {
    key: 'enableAllProjectMcpServers',
    label: msg`Enable All Project MCP Servers`,
    category: 'MCP Servers',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'enable_all_project_mcp_servers',
    description: msg`Auto-enable all project-level MCP servers`,
  },
  {
    key: 'enabledMcpjsonServers',
    label: msg`Enabled MCP JSON Servers`,
    category: 'MCP Servers',
    fieldType: 'string[]',
    record: 'root',
    recordKey: 'enabled_mcpjson_servers',
    description: msg`MCP servers explicitly enabled`,
  },
  {
    key: 'disabledMcpjsonServers',
    label: msg`Disabled MCP JSON Servers`,
    category: 'MCP Servers',
    fieldType: 'string[]',
    record: 'root',
    recordKey: 'disabled_mcpjson_servers',
    description: msg`MCP servers explicitly disabled`,
  },

  // ── Plugins ──────────────────────────────────────────
  {
    key: 'enabledPlugins',
    label: msg`Enabled Plugins`,
    category: 'Plugins',
    fieldType: 'dict',
    record: 'root',
    recordKey: 'enabled_plugins',
    description: msg`Plugin enable/disable flags`,
  },
  {
    key: 'extraKnownMarketplaces',
    label: msg`Extra Known Marketplaces`,
    category: 'Plugins',
    fieldType: 'object',
    record: 'root',
    recordKey: 'extra_known_marketplaces',
    description: msg`Additional plugin marketplace URLs`,
  },

  // ── Attribution ──────────────────────────────────────
  {
    key: 'attribution.commit',
    label: msg`Commit Attribution`,
    category: 'Attribution',
    fieldType: 'string',
    record: 'attribution',
    recordKey: 'commit',
    description: msg`Co-author line for git commits`,
  },
  {
    key: 'attribution.pr',
    label: msg`PR Attribution`,
    category: 'Attribution',
    fieldType: 'string',
    record: 'attribution',
    recordKey: 'pr',
    description: msg`Attribution line for pull requests`,
  },

  // ── Updates & Maintenance ────────────────────────────
  {
    key: 'autoUpdatesChannel',
    label: msg`Auto Updates Channel`,
    category: 'Updates & Maintenance',
    fieldType: 'string',
    record: 'root',
    recordKey: 'auto_updates_channel',
    description: msg`Update channel for auto-updates`,
    allowedValues: ['stable', 'beta', 'disabled'],
  },
  {
    key: 'cleanupPeriodDays',
    label: msg`Cleanup Period (Days)`,
    category: 'Updates & Maintenance',
    fieldType: 'number',
    record: 'root',
    recordKey: 'cleanup_period_days',
    description: msg`Days before old sessions are cleaned up`,
  },

  // ── Company & Team ───────────────────────────────────
  {
    key: 'companyAnnouncements',
    label: msg`Company Announcements`,
    category: 'Company & Team',
    fieldType: 'string[]',
    record: 'root',
    recordKey: 'company_announcements',
    description: msg`Announcements shown at startup`,
  },
  {
    key: 'teammateMode',
    label: msg`Teammate Mode`,
    category: 'Company & Team',
    fieldType: 'string',
    record: 'root',
    recordKey: 'teammate_mode',
    description: msg`Team collaboration mode`,
  },
  {
    key: 'includeCoAuthoredBy',
    label: msg`Include Co-Authored-By`,
    category: 'Company & Team',
    fieldType: 'boolean',
    record: 'root',
    recordKey: 'include_co_authored_by',
    description: msg`Add Co-Authored-By to git commits`,
  },
];

/** Ordered list of categories for display. */
export const CATEGORY_ORDER = [
  'Model & Performance',
  'Permissions',
  'Sandbox',
  'Authentication',
  'Environment',
  'Hooks',
  'Files & Directories',
  'UI & Display',
  'MCP Servers',
  'Plugins',
  'Attribution',
  'Updates & Maintenance',
  'Company & Team',
];

// ── JSON path mapping ───────────────────────────────────

const RECORD_JSON_PATH: Record<string, string> = {
  root: '',
  permissions: '/permissions',
  sandbox: '/sandbox',
  attribution: '/attribution',
};

// ── Default values ──────────────────────────────────────

function isDefaultValue(value: unknown, fieldType: FieldType): boolean {
  if (value === undefined || value === null) return true;
  if (fieldType === 'string' && value === '') return true;
  if (fieldType === 'number' && value === 0) return true;
  if (fieldType === 'boolean' && value === false) return true;
  if (fieldType === 'string[]' && Array.isArray(value) && value.length === 0) return true;
  if (fieldType === 'dict' && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0)
    return true;
  if (fieldType === 'object' && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0)
    return true;
  return false;
}

// ── Extracting values from record lists ─────────────────

/**
 * Read a dynamic wire key off a record.
 *
 * These records are classes populated field-by-field from JSON, so a key the
 * class does not declare still exists at runtime — but a class type has no
 * index signature, so `record[key]` will not type-check. `Reflect.get` is the
 * cast-free way to say it; the previous `as Record<string, unknown>` did not
 * even compile, since a class with methods does not overlap that type.
 */
function readWireKey(record: object, key: string): unknown {
  return Reflect.get(record, key);
}

function getRecordValue(recordList: ClaudeSettingsJsonRecordList | null, def: FieldDef): unknown {
  if (!recordList) return undefined;

  // Handle expanded env var fields: recordKey starts with 'env.'
  if (def.recordKey.startsWith('env.')) {
    const envVarName = def.recordKey.substring(4);
    const root = recordList.root;
    if (!root) return undefined;
    const envDict = readWireKey(root, 'env') as Record<string, string> | undefined;
    if (!envDict || typeof envDict !== 'object') return undefined;
    return envDict[envVarName] ?? undefined;
  }

  const sub = recordList[def.record as keyof ClaudeSettingsJsonRecordList];
  if (!sub || typeof sub !== 'object') return undefined;
  const val = readWireKey(sub, def.recordKey);
  return val;
}

// ── Flatten & merge ─────────────────────────────────────

export function flattenSettings(
  userRecords: ClaudeSettingsJsonRecordList | null,
  projectRecords: ClaudeSettingsJsonRecordList | null,
  localRecords: ClaudeSettingsJsonRecordList | null,
): SettingsField[] {
  return FIELD_DEFS.map((def) => {
    const userVal = getRecordValue(userRecords, def);
    const projectVal = getRecordValue(projectRecords, def);
    const localVal = getRecordValue(localRecords, def);

    const userSet = !isDefaultValue(userVal, def.fieldType);
    const projectSet = !isDefaultValue(projectVal, def.fieldType);
    const localSet = !isDefaultValue(localVal, def.fieldType);

    // Effective: local > project > user > default
    let effectiveValue: unknown;
    let scope: Scope;

    if (localSet) {
      effectiveValue = localVal;
      scope = 'local';
    } else if (projectSet) {
      effectiveValue = projectVal;
      scope = 'project';
    } else if (userSet) {
      effectiveValue = userVal;
      scope = 'user';
    } else {
      effectiveValue = undefined;
      scope = 'default';
    }

    return {
      key: def.key,
      label: i18n._(def.label),
      category: def.category,
      fieldType: def.fieldType,
      effectiveValue,
      scope,
      userValue: userSet ? userVal : undefined,
      projectValue: projectSet ? projectVal : undefined,
      localValue: localSet ? localVal : undefined,
      jsonPath: RECORD_JSON_PATH[def.record],
      recordType: def.record,
      description: def.description ? i18n._(def.description) : undefined,
      allowedValues: def.allowedValues,
    };
  });
}

// ── Search ──────────────────────────────────────────────

export function matchesSearch(field: SettingsField, query: string): boolean {
  const q = query.toLowerCase();
  if (field.label.toLowerCase().includes(q)) return true;
  if (field.key.toLowerCase().includes(q)) return true;
  if (field.category.toLowerCase().includes(q)) return true;
  if (field.description?.toLowerCase().includes(q)) return true;
  // Search within stringified values
  if (field.effectiveValue !== undefined) {
    const str = typeof field.effectiveValue === 'string' ? field.effectiveValue : JSON.stringify(field.effectiveValue);
    if (str.toLowerCase().includes(q)) return true;
  }
  return false;
}

// ── Group by category ───────────────────────────────────

export function groupByCategory(fields: SettingsField[]): Map<string, SettingsField[]> {
  const groups = new Map<string, SettingsField[]>();
  for (const cat of CATEGORY_ORDER) {
    const catFields = fields.filter((f) => f.category === cat);
    if (catFields.length > 0) {
      groups.set(cat, catFields);
    }
  }
  return groups;
}

/**
 * Display names for the setting categories.
 *
 * The category itself stays the English string everywhere it is USED as data —
 * the grouping Map's key, the accordion's `value`, and `CATEGORY_ORDER` — so
 * ordering and open/closed state key off something stable. Only the heading the
 * user reads goes through here.
 */
const CATEGORY_LABELS: Record<string, MessageDescriptor> = {
  'Model & Performance': msg`Model & Performance`,
  Permissions: msg`Permissions`,
  Sandbox: msg`Sandbox`,
  Authentication: msg`Authentication`,
  Environment: msg`Environment`,
  Hooks: msg`Hooks`,
  'Files & Directories': msg`Files & Directories`,
  'UI & Display': msg`UI & Display`,
  'MCP Servers': msg`MCP Servers`,
  Plugins: msg`Plugins`,
  Attribution: msg`Attribution`,
  'Updates & Maintenance': msg`Updates & Maintenance`,
  'Company & Team': msg`Company & Team`,
};

/** Translated heading for a category key; unknown keys fall back to the key. */
export function categoryLabel(category: string): string {
  const descriptor = CATEGORY_LABELS[category];
  return descriptor ? i18n._(descriptor) : category;
}
