/**
 * Claude settings barrel — re-exports all settings record types
 * plus the ClaudeSettingsRecordList convenience class.
 */
export { ClaudeSettingsFsRecord } from './base';
export { ClaudeOAuthAccountFsRecord } from './oauth-account';
export { ClaudeProjectEntryFsRecord } from './project-entry';
export { ClaudeModelUsageFsRecord } from './model-usage';
export { ClaudeSettingsMcpServerFsRecord } from './mcp-server-config';
export { ClaudeFeatureFlagsFsRecord } from './feature-flags';
export { ClaudeTipsHistoryFsRecord } from './tips-history';
export { ClaudeSkillUsageFsRecord } from './skill-usage';
export { ClaudeGithubReposFsRecord } from './github-repos';

// ── ClaudeSettingsRecordList ───────────────────────────────────

import { SourceFileRecordList } from '../../source-file-record-list';
import { RecordType } from '../../record-types';
import { ClaudeSettingsFsRecord } from './base';
import { ClaudeOAuthAccountFsRecord } from './oauth-account';
import { ClaudeProjectEntryFsRecord } from './project-entry';
import { ClaudeModelUsageFsRecord } from './model-usage';
import { ClaudeSettingsMcpServerFsRecord } from './mcp-server-config';
import { ClaudeFeatureFlagsFsRecord } from './feature-flags';
import { ClaudeTipsHistoryFsRecord } from './tips-history';
import { ClaudeSkillUsageFsRecord } from './skill-usage';
import { ClaudeGithubReposFsRecord } from './github-repos';

/**
 * ClaudeSettingsRecordList — reads `~/.claude.json` via the backend and
 * extracts typed sub-records (root settings, OAuth account, projects, etc.).
 */
export class ClaudeSettingsRecordList extends SourceFileRecordList {
  static override _listType = 'claude_settings';

  // ── Convenience typed accessors ──────────────────────

  /** Root settings record (identity, onboarding, counters). */
  get root(): ClaudeSettingsFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_BASE)[0] as ClaudeSettingsFsRecord | undefined;
  }

  /** OAuth account record. */
  get oauthAccount(): ClaudeOAuthAccountFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_OAUTH_ACCOUNT)[0] as ClaudeOAuthAccountFsRecord | undefined;
  }

  /** Feature flags record. */
  get featureFlags(): ClaudeFeatureFlagsFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_FEATURE_FLAGS)[0] as ClaudeFeatureFlagsFsRecord | undefined;
  }

  /** All project entries. */
  get projects(): ClaudeProjectEntryFsRecord[] {
    return this.byType(RecordType.CLAUDE_SETTINGS_PROJECT_ENTRY) as ClaudeProjectEntryFsRecord[];
  }

  /** All model usage entries. */
  get modelUsages(): ClaudeModelUsageFsRecord[] {
    return this.byType(RecordType.CLAUDE_SETTINGS_MODEL_USAGE) as ClaudeModelUsageFsRecord[];
  }

  /** All MCP server configs. */
  get mcpServers(): ClaudeSettingsMcpServerFsRecord[] {
    return this.byType(RecordType.CLAUDE_SETTINGS_MCP_SERVER) as ClaudeSettingsMcpServerFsRecord[];
  }

  /** Tips history record. */
  get tipsHistory(): ClaudeTipsHistoryFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_TIPS_HISTORY)[0] as ClaudeTipsHistoryFsRecord | undefined;
  }

  /** All skill usage entries. */
  get skillUsages(): ClaudeSkillUsageFsRecord[] {
    return this.byType(RecordType.CLAUDE_SETTINGS_SKILL_USAGE) as ClaudeSkillUsageFsRecord[];
  }

  /** GitHub repos record. */
  get githubRepos(): ClaudeGithubReposFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_GITHUB_REPOS)[0] as ClaudeGithubReposFsRecord | undefined;
  }

  /** Convenience factory: create and immediately load. */
  static async load(computeNodeId: string): Promise<ClaudeSettingsRecordList> {
    const list = new ClaudeSettingsRecordList(computeNodeId);
    await list.load();
    return list;
  }
}
