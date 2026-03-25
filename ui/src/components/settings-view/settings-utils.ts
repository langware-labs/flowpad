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
  label: string;
  category: string;
  fieldType: FieldType;
  /** Which sub-record this field lives in: 'root' | 'permissions' | 'sandbox' | 'attribution' */
  record: 'root' | 'permissions' | 'sandbox' | 'attribution';
  /** The snake_case property name on the FsRecord class */
  recordKey: string;
  description?: string;
  allowedValues?: string[];
}

const FIELD_DEFS: FieldDef[] = [
  // ── Model & Performance ──────────────────────────────
  { key: 'model', label: 'Model', category: 'Model & Performance', fieldType: 'string', record: 'root', recordKey: 'model', description: 'Default model to use for conversations' },
  { key: 'availableModels', label: 'Available Models', category: 'Model & Performance', fieldType: 'string[]', record: 'root', recordKey: 'available_models', description: 'List of models available for selection' },
  { key: 'alwaysThinkingEnabled', label: 'Always Thinking Enabled', category: 'Model & Performance', fieldType: 'boolean', record: 'root', recordKey: 'always_thinking_enabled', description: 'Enable extended thinking for all conversations' },
  { key: 'outputStyle', label: 'Output Style', category: 'Model & Performance', fieldType: 'string', record: 'root', recordKey: 'output_style', description: 'Default output style', allowedValues: ['concise', 'verbose', 'normal'] },

  // ── Permissions ──────────────────────────────────────
  { key: 'permissions.allow', label: 'Allow', category: 'Permissions', fieldType: 'string[]', record: 'permissions', recordKey: 'allow', description: 'Tool patterns allowed without prompting' },
  { key: 'permissions.ask', label: 'Ask', category: 'Permissions', fieldType: 'string[]', record: 'permissions', recordKey: 'ask', description: 'Tool patterns that require confirmation' },
  { key: 'permissions.deny', label: 'Deny', category: 'Permissions', fieldType: 'string[]', record: 'permissions', recordKey: 'deny', description: 'Tool patterns that are always denied' },
  { key: 'permissions.additionalDirectories', label: 'Additional Directories', category: 'Permissions', fieldType: 'string[]', record: 'permissions', recordKey: 'additional_directories', description: 'Extra directories Claude can access' },
  { key: 'permissions.defaultMode', label: 'Default Mode', category: 'Permissions', fieldType: 'string', record: 'permissions', recordKey: 'default_mode', description: 'Default permission mode', allowedValues: ['default', 'plan', 'bypassPermissions'] },
  { key: 'permissions.disableBypassPermissionsMode', label: 'Disable Bypass Permissions Mode', category: 'Permissions', fieldType: 'string', record: 'permissions', recordKey: 'disable_bypass_permissions_mode', description: 'Prevent use of bypass permissions mode' },

  // ── Sandbox ──────────────────────────────────────────
  { key: 'sandbox.enabled', label: 'Sandbox Enabled', category: 'Sandbox', fieldType: 'boolean', record: 'sandbox', recordKey: 'enabled', description: 'Enable command sandboxing' },
  { key: 'sandbox.autoAllowBashIfSandboxed', label: 'Auto-allow Bash if Sandboxed', category: 'Sandbox', fieldType: 'boolean', record: 'sandbox', recordKey: 'auto_allow_bash_if_sandboxed', description: 'Auto-approve bash when sandbox is active' },
  { key: 'sandbox.excludedCommands', label: 'Excluded Commands', category: 'Sandbox', fieldType: 'string[]', record: 'sandbox', recordKey: 'excluded_commands', description: 'Commands excluded from sandboxing' },
  { key: 'sandbox.allowUnsandboxedCommands', label: 'Allow Unsandboxed Commands', category: 'Sandbox', fieldType: 'boolean', record: 'sandbox', recordKey: 'allow_unsandboxed_commands', description: 'Allow commands to run outside sandbox' },
  { key: 'sandbox.enableWeakerNestedSandbox', label: 'Enable Weaker Nested Sandbox', category: 'Sandbox', fieldType: 'boolean', record: 'sandbox', recordKey: 'enable_weaker_nested_sandbox', description: 'Use weaker sandbox for nested commands' },
  { key: 'sandbox.network.allowedDomains', label: 'Allowed Domains', category: 'Sandbox', fieldType: 'string[]', record: 'sandbox', recordKey: 'network_allowed_domains', description: 'Domains accessible from sandbox' },
  { key: 'sandbox.network.allowUnixSockets', label: 'Allow Unix Sockets', category: 'Sandbox', fieldType: 'string[]', record: 'sandbox', recordKey: 'network_allow_unix_sockets', description: 'Specific unix sockets allowed in sandbox' },
  { key: 'sandbox.network.allowAllUnixSockets', label: 'Allow All Unix Sockets', category: 'Sandbox', fieldType: 'boolean', record: 'sandbox', recordKey: 'network_allow_all_unix_sockets', description: 'Allow all unix socket connections' },
  { key: 'sandbox.network.allowLocalBinding', label: 'Allow Local Binding', category: 'Sandbox', fieldType: 'boolean', record: 'sandbox', recordKey: 'network_allow_local_binding', description: 'Allow binding to local ports' },
  { key: 'sandbox.network.httpProxyPort', label: 'HTTP Proxy Port', category: 'Sandbox', fieldType: 'number', record: 'sandbox', recordKey: 'network_http_proxy_port', description: 'Port for HTTP proxy in sandbox' },
  { key: 'sandbox.network.socksProxyPort', label: 'SOCKS Proxy Port', category: 'Sandbox', fieldType: 'number', record: 'sandbox', recordKey: 'network_socks_proxy_port', description: 'Port for SOCKS proxy in sandbox' },

  // ── Authentication ───────────────────────────────────
  { key: 'apiKeyHelper', label: 'API Key Helper', category: 'Authentication', fieldType: 'string', record: 'root', recordKey: 'api_key_helper', description: 'Command to retrieve API key dynamically' },
  { key: 'forceLoginMethod', label: 'Force Login Method', category: 'Authentication', fieldType: 'string', record: 'root', recordKey: 'force_login_method', description: 'Force a specific authentication method' },
  { key: 'forceLoginOrgUUID', label: 'Force Login Org UUID', category: 'Authentication', fieldType: 'string', record: 'root', recordKey: 'force_login_org_uuid', description: 'Force login to a specific organization' },
  { key: 'awsAuthRefresh', label: 'AWS Auth Refresh', category: 'Authentication', fieldType: 'string', record: 'root', recordKey: 'aws_auth_refresh', description: 'Command to refresh AWS credentials' },
  { key: 'awsCredentialExport', label: 'AWS Credential Export', category: 'Authentication', fieldType: 'string', record: 'root', recordKey: 'aws_credential_export', description: 'Command to export AWS credentials' },

  // ── Environment (dict) ─────────────────────────────────
  { key: 'env', label: 'Environment Variables', category: 'Environment', fieldType: 'dict', record: 'root', recordKey: 'env', description: 'Full environment variable dictionary' },

  // ── Environment (individual vars) ──────────────────────
  { key: 'env.ANTHROPIC_API_KEY', label: 'API Key', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.ANTHROPIC_API_KEY', description: 'Anthropic API key for direct API access' },
  { key: 'env.ANTHROPIC_MODEL', label: 'Model Override', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.ANTHROPIC_MODEL', description: 'Override the default model via environment' },
  { key: 'env.CLAUDE_CODE_MAX_TURNS', label: 'Max Turns', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_MAX_TURNS', description: 'Maximum number of agentic turns' },
  { key: 'env.CLAUDE_CODE_USE_BEDROCK', label: 'Use Bedrock', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_USE_BEDROCK', description: 'Use AWS Bedrock as the backend', allowedValues: ['0', '1'] },
  { key: 'env.CLAUDE_CODE_USE_VERTEX', label: 'Use Vertex', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_USE_VERTEX', description: 'Use Google Vertex AI as the backend', allowedValues: ['0', '1'] },
  { key: 'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', label: 'Disable Non-essential Traffic', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', description: 'Disable telemetry and analytics', allowedValues: ['0', '1'] },
  { key: 'env.ANTHROPIC_BASE_URL', label: 'Base URL', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.ANTHROPIC_BASE_URL', description: 'Custom API base URL for Anthropic' },
  { key: 'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS', label: 'Max Output Tokens', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS', description: 'Maximum tokens per model response' },
  { key: 'env.HTTP_PROXY', label: 'HTTP Proxy', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.HTTP_PROXY', description: 'HTTP proxy URL for network requests' },
  { key: 'env.HTTPS_PROXY', label: 'HTTPS Proxy', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.HTTPS_PROXY', description: 'HTTPS proxy URL for network requests' },
  { key: 'env.CLAUDE_CODE_SKIP_PERMISSIONS_WARMUP', label: 'Skip Permissions Warmup', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_SKIP_PERMISSIONS_WARMUP', description: 'Skip initial permission check on startup', allowedValues: ['0', '1'] },
  { key: 'env.BASH_DEFAULT_TIMEOUT_MS', label: 'Bash Timeout (ms)', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.BASH_DEFAULT_TIMEOUT_MS', description: 'Default bash command timeout in milliseconds' },
  { key: 'env.AWS_REGION', label: 'AWS Region', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.AWS_REGION', description: 'AWS region for Bedrock' },
  { key: 'env.AWS_PROFILE', label: 'AWS Profile', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.AWS_PROFILE', description: 'AWS CLI profile name' },
  { key: 'env.CLOUD_ML_REGION', label: 'Vertex Region', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLOUD_ML_REGION', description: 'GCP region for Vertex AI' },
  { key: 'env.ANTHROPIC_VERTEX_PROJECT_ID', label: 'Vertex Project ID', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.ANTHROPIC_VERTEX_PROJECT_ID', description: 'GCP project ID for Vertex AI' },
  { key: 'env.CLAUDE_CODE_ANTHROPIC_TIMEOUT', label: 'API Timeout', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_ANTHROPIC_TIMEOUT', description: 'Timeout for Anthropic API calls in ms' },
  { key: 'env.CLAUDE_CODE_MAX_MEMORY', label: 'Max Memory', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_MAX_MEMORY', description: 'Maximum memory usage limit' },
  { key: 'env.DISABLE_PROMPT_CACHING', label: 'Disable Prompt Caching', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.DISABLE_PROMPT_CACHING', description: 'Disable API prompt caching', allowedValues: ['0', '1'] },
  { key: 'env.CLAUDE_CODE_REASONING_EFFORT', label: 'Reasoning Effort', category: 'Environment', fieldType: 'string', record: 'root', recordKey: 'env.CLAUDE_CODE_REASONING_EFFORT', description: 'Control reasoning effort level', allowedValues: ['low', 'medium', 'high'] },

  // ── Hooks ────────────────────────────────────────────
  { key: 'hooks', label: 'Hooks', category: 'Hooks', fieldType: 'object', record: 'root', recordKey: 'hooks', description: 'Shell commands triggered by tool events' },
  { key: 'disableAllHooks', label: 'Disable All Hooks', category: 'Hooks', fieldType: 'boolean', record: 'root', recordKey: 'disable_all_hooks', description: 'Disable all hook execution' },

  // ── Files & Directories ──────────────────────────────
  { key: 'respectGitignore', label: 'Respect Gitignore', category: 'Files & Directories', fieldType: 'boolean', record: 'root', recordKey: 'respect_gitignore', description: 'Respect .gitignore when searching files' },
  { key: 'fileSuggestion', label: 'File Suggestion', category: 'Files & Directories', fieldType: 'object', record: 'root', recordKey: 'file_suggestion', description: 'File suggestion configuration' },
  { key: 'plansDirectory', label: 'Plans Directory', category: 'Files & Directories', fieldType: 'string', record: 'root', recordKey: 'plans_directory', description: 'Directory for saving plan files' },

  // ── UI & Display ─────────────────────────────────────
  { key: 'language', label: 'Language', category: 'UI & Display', fieldType: 'string', record: 'root', recordKey: 'language', description: 'Preferred language for responses' },
  { key: 'showTurnDuration', label: 'Show Turn Duration', category: 'UI & Display', fieldType: 'boolean', record: 'root', recordKey: 'show_turn_duration', description: 'Show timing info for each turn' },
  { key: 'spinnerVerbs', label: 'Spinner Verbs', category: 'UI & Display', fieldType: 'object', record: 'root', recordKey: 'spinner_verbs', description: 'Custom verbs for the progress spinner' },
  { key: 'spinnerTipsEnabled', label: 'Spinner Tips Enabled', category: 'UI & Display', fieldType: 'boolean', record: 'root', recordKey: 'spinner_tips_enabled', description: 'Show tips while spinner is active' },
  { key: 'spinnerTipsOverride', label: 'Spinner Tips Override', category: 'UI & Display', fieldType: 'object', record: 'root', recordKey: 'spinner_tips_override', description: 'Custom tip content for the spinner' },
  { key: 'terminalProgressBarEnabled', label: 'Terminal Progress Bar Enabled', category: 'UI & Display', fieldType: 'boolean', record: 'root', recordKey: 'terminal_progress_bar_enabled', description: 'Show a progress bar in the terminal' },
  { key: 'prefersReducedMotion', label: 'Prefers Reduced Motion', category: 'UI & Display', fieldType: 'boolean', record: 'root', recordKey: 'prefers_reduced_motion', description: 'Reduce animations and motion effects' },
  { key: 'statusLine', label: 'Status Line', category: 'UI & Display', fieldType: 'object', record: 'root', recordKey: 'status_line', description: 'Status line display configuration' },

  // ── MCP Servers ──────────────────────────────────────
  { key: 'enableAllProjectMcpServers', label: 'Enable All Project MCP Servers', category: 'MCP Servers', fieldType: 'boolean', record: 'root', recordKey: 'enable_all_project_mcp_servers', description: 'Auto-enable all project-level MCP servers' },
  { key: 'enabledMcpjsonServers', label: 'Enabled MCP JSON Servers', category: 'MCP Servers', fieldType: 'string[]', record: 'root', recordKey: 'enabled_mcpjson_servers', description: 'MCP servers explicitly enabled' },
  { key: 'disabledMcpjsonServers', label: 'Disabled MCP JSON Servers', category: 'MCP Servers', fieldType: 'string[]', record: 'root', recordKey: 'disabled_mcpjson_servers', description: 'MCP servers explicitly disabled' },

  // ── Plugins ──────────────────────────────────────────
  { key: 'enabledPlugins', label: 'Enabled Plugins', category: 'Plugins', fieldType: 'dict', record: 'root', recordKey: 'enabled_plugins', description: 'Plugin enable/disable flags' },
  { key: 'extraKnownMarketplaces', label: 'Extra Known Marketplaces', category: 'Plugins', fieldType: 'object', record: 'root', recordKey: 'extra_known_marketplaces', description: 'Additional plugin marketplace URLs' },

  // ── Attribution ──────────────────────────────────────
  { key: 'attribution.commit', label: 'Commit Attribution', category: 'Attribution', fieldType: 'string', record: 'attribution', recordKey: 'commit', description: 'Co-author line for git commits' },
  { key: 'attribution.pr', label: 'PR Attribution', category: 'Attribution', fieldType: 'string', record: 'attribution', recordKey: 'pr', description: 'Attribution line for pull requests' },

  // ── Updates & Maintenance ────────────────────────────
  { key: 'autoUpdatesChannel', label: 'Auto Updates Channel', category: 'Updates & Maintenance', fieldType: 'string', record: 'root', recordKey: 'auto_updates_channel', description: 'Update channel for auto-updates', allowedValues: ['stable', 'beta', 'disabled'] },
  { key: 'cleanupPeriodDays', label: 'Cleanup Period (Days)', category: 'Updates & Maintenance', fieldType: 'number', record: 'root', recordKey: 'cleanup_period_days', description: 'Days before old sessions are cleaned up' },

  // ── Company & Team ───────────────────────────────────
  { key: 'companyAnnouncements', label: 'Company Announcements', category: 'Company & Team', fieldType: 'string[]', record: 'root', recordKey: 'company_announcements', description: 'Announcements shown at startup' },
  { key: 'teammateMode', label: 'Teammate Mode', category: 'Company & Team', fieldType: 'string', record: 'root', recordKey: 'teammate_mode', description: 'Team collaboration mode' },
  { key: 'includeCoAuthoredBy', label: 'Include Co-Authored-By', category: 'Company & Team', fieldType: 'boolean', record: 'root', recordKey: 'include_co_authored_by', description: 'Add Co-Authored-By to git commits' },
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
  if (fieldType === 'dict' && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0) return true;
  if (fieldType === 'object' && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0) return true;
  return false;
}

// ── Extracting values from record lists ─────────────────

function getRecordValue(
  recordList: ClaudeSettingsJsonRecordList | null,
  def: FieldDef,
): unknown {
  if (!recordList) return undefined;

  // Handle expanded env var fields: recordKey starts with 'env.'
  if (def.recordKey.startsWith('env.')) {
    const envVarName = def.recordKey.substring(4);
    const root = recordList.root;
    if (!root) return undefined;
    const envDict = (root as Record<string, unknown>).env as Record<string, string> | undefined;
    if (!envDict || typeof envDict !== 'object') return undefined;
    return envDict[envVarName] ?? undefined;
  }

  const sub = recordList[def.record as keyof ClaudeSettingsJsonRecordList];
  if (!sub || typeof sub !== 'object') return undefined;
  const val = (sub as Record<string, unknown>)[def.recordKey];
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
      label: def.label,
      category: def.category,
      fieldType: def.fieldType,
      effectiveValue,
      scope,
      userValue: userSet ? userVal : undefined,
      projectValue: projectSet ? projectVal : undefined,
      localValue: localSet ? localVal : undefined,
      jsonPath: RECORD_JSON_PATH[def.record],
      recordType: def.record,
      description: def.description,
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
    const str = typeof field.effectiveValue === 'string'
      ? field.effectiveValue
      : JSON.stringify(field.effectiveValue);
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
