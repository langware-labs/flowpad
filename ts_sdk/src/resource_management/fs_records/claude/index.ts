/**
 * Claude record types barrel.
 *
 * Only classes the backend can actually put on the wire live here. The record
 * types it can emit are fixed by `_EXTRACTORS` in
 * `flow_sdk/fs_store/source_file_records.py` (settings.json, managed-settings,
 * mcp.json) plus what the indexer broadcasts (`claude_session`, `claude_hook`).
 * Importing this module is also what registers those classes — registration is
 * a module-level side effect, so the barrel is load-bearing, not decorative.
 */
export { ClaudeSessionRecord, ClaudeSessionFsRecord, type ClaudeSessionRecordData, type ClaudeSessionFsRecordData } from './claude-session';
export { ClaudeHookFsRecord } from './claude-hook';

// Claude settings.json records (user/project/local)
export * from './claude-settings-json/index';

export type { TranscriptEntryData } from './transcript-entry-data';
