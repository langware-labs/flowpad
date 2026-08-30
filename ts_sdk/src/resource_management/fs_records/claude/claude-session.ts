/**
 * ClaudeSessionRecord — a single Claude Code session.
 * Read-only: sessions are created/updated by the CLI, not the frontend.
 */
import { FsRecord, type FsRecordData } from '../fs-record';
import { RecordType } from '../record-types';
import { StorageLayout } from '../storage-layout';
import { fsRecordTypeRegistry } from '../record-type-registry';
import { dataManager } from '../../../APIEntity';
import { ActionInfo } from '../../../models/ActionInfo';
import type { TranscriptEntryData } from './transcript-entry-data';

export type ClaudeSessionStatus = 'idle' | 'running' | 'complete';

/** Plain-data shape for embedded session (e.g. via ?include=session). */
export interface ClaudeSessionRecordData {
  id: string;
  type: string;
  name: string;
  session_id: string;
  slug: string;
  model: string;
  cwd: string;
  version: string;
  git_branch: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  duration_ms: number;
  tools_used: string[];
  has_plan: boolean;
  jsonl_path: string;
  status?: ClaudeSessionStatus;
  last_stop_reason?: string;
  start_time?: string;

  // Fields from enriched scan (from_jsonl)
  last_user_message?: string | null;
  task_path?: string | null;
  modified_at?: string | null;
  created_at?: string | null;
  estimated_cost_usd?: number;
  models_used?: string[];
  primary_model?: string | null;
  /** Alias for jsonl_path — set by from_jsonl() for backward compatibility. */
  path?: string | null;
  source_file?: string | null;
}

/** @deprecated Use ClaudeSessionRecordData */
export type ClaudeSessionFsRecordData = ClaudeSessionRecordData;

export class ClaudeSessionRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SESSION;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FILE;

  session_id = '';
  project_path?: string;
  cwd?: string;
  version?: string;
  git_branch?: string;
  slug?: string;
  model?: string;

  message_count = 0;
  user_message_count = 0;
  assistant_message_count = 0;

  input_tokens = 0;
  output_tokens = 0;
  cache_read_input_tokens = 0;
  cache_creation_input_tokens = 0;
  duration_ms = 0;

  tools_used?: string[];
  has_plan = false;
  jsonl_path?: string;
  status?: ClaudeSessionStatus;
  last_stop_reason?: string;
  start_time?: string;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }

  /**
   * Fetch transcript entries for a Claude session.
   * Uses ActionInfo -> dataManager.callAction() (entity layer pattern).
   *
   * @param sessionId - Claude session UUID (worker_session_id)
   * @param options.project - Optional project path for O(1) backend lookup
   * @returns Array of transcript entry data objects
   */
  static async fetchTranscript(
    sessionId: string,
    options?: { project?: string },
  ): Promise<TranscriptEntryData[]> {
    const action = new ActionInfo('session-transcript', 'compute_node', '@local', 'GET');
    action.queryParameters = {
      session_id: sessionId,
      ...(options?.project ? { project: options.project } : {}),
    };
    try {
      const result = await dataManager.callAction<void, TranscriptEntryData[]>(action);
      return result ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch the raw JSONL bytes of a Claude session as a UTF-8 string. The
   * browser can't read ~/.claude/projects/.../<sid>.jsonl directly (no static
   * mount), so this routes through the backend which has filesystem access.
   *
   * @param sessionId - Claude session UUID
   * @param options.project - Optional project path for O(1) backend lookup
   * @returns UTF-8 text content of the JSONL, or null when the session has
   *   no jsonl on disk (or the request failed).
   */
  static async fetchTranscriptRaw(
    sessionId: string,
    options?: { project?: string },
  ): Promise<string | null> {
    const action = new ActionInfo('session-transcript-raw', 'compute_node', '@local', 'GET');
    action.queryParameters = {
      session_id: sessionId,
      ...(options?.project ? { project: options.project } : {}),
    };
    try {
      const result = await dataManager.callAction<void, { content?: string; jsonl_path?: string | null }>(action);
      const content = result?.content;
      if (!content) return null;
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Trigger server-side discovery for a specific session and return the
   * refreshed record (including computed properties like start_time).
   *
   * @param sessionId - Claude session UUID (worker_session_id)
   * @param options.project - Optional project path for O(1) backend lookup
   * @param options.computeNodeId - ComputeNode entity ID (default '@local')
   */
  static async discover(
    sessionId: string,
    options?: { project?: string; computeNodeId?: string },
  ): Promise<ClaudeSessionRecord | null> {
    const computeNodeId = options?.computeNodeId ?? '@local';
    const action = new ActionInfo('discovery/claude_session', 'compute_node', computeNodeId, 'GET');
    action.queryParameters = {
      uuid: sessionId,
      ...(options?.project ? { project: options.project } : {}),
    };
    try {
      const result = await dataManager.callAction<void, ClaudeSessionRecordData>(action);
      if (!result) return null;
      // Object.assign after construction avoids useDefineForClassFields overwriting data
      const record = Object.assign(new ClaudeSessionRecord(), result);
      return record;
    } catch {
      return null;
    }
  }
}

/** @deprecated Use ClaudeSessionRecord */
export const ClaudeSessionFsRecord = ClaudeSessionRecord;

fsRecordTypeRegistry.register(ClaudeSessionRecord._recordType, ClaudeSessionRecord as any);
