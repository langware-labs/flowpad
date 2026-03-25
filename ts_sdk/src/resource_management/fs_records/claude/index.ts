/**
 * Claude record types barrel — re-exports all concrete Claude record classes.
 */
export { ClaudeSessionRecord, ClaudeSessionFsRecord, type ClaudeSessionRecordData, type ClaudeSessionFsRecordData } from './claude-session';
export { ClaudeRootFsRecord } from './claude-root';
export { ClaudeHookFsRecord, ClaudeHookEntryFsRecord } from './claude-hook';
export { ClaudeMcpServerFsRecord } from './claude-mcp-server';
export { ClaudeCommandFsRecord } from './claude-command';
export { ClaudeHistoryFsRecord } from './claude-history';
export { ClaudeHistoryEntryFsRecord } from './claude-history-entry';
export { ClaudeActiveSessionsFsRecord, ClaudeActiveSessionFsRecord } from './claude-active-sessions';
export { ClaudeAccountFsRecord } from './claude-account';

// Claude settings sub-records (~/.claude.json)
export * from './claude-settings/index';

// Claude settings.json records (user/project/local)
export * from './claude-settings-json/index';

// Claude transcript entry records
export * from './transcript/index';

// Re-export TranscriptEntryData for convenience
export type { TranscriptEntryData } from './transcript/transcript-entry';
