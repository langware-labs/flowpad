/**
 * The shape of one entry in a Claude Code session JSONL, as returned by
 * `ClaudeSessionRecord.fetchTranscript()`.
 *
 * A wire type only. The FsRecord classes that used to wrap these entries are
 * gone: no backend path ever emitted a `transcript_entry` record, so nothing
 * could construct them.
 */
export interface TranscriptEntryData {
  entry_type: string;
  entry_uuid: string;
  timestamp: string;
  session_id: string;
  subtype?: string;
  parent_uuid?: string;
  is_sidechain?: boolean;
  message?: {
    content?: any;
    model?: string;
    stop_reason?: string;
    usage?: Record<string, number>;
  };
  data?: Record<string, any>;
}
