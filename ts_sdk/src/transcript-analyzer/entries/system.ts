/**
 * SystemEntry — system / progress / control-plane events.
 *
 * Folds:
 *   - Claude `type=="system"` lines (subtype = turn_duration, api_error,
 *     stop_hook_summary, compact_boundary, …).
 *   - Claude `type=="progress"` lines (subtype = data.type — hook_progress,
 *     bash_progress, tool_use, …).
 *   - Codex stream-event control lines (subtype = thread.started,
 *     turn.started, turn.completed).
 */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface SystemEntryData extends TranscriptEntryBase {
  subtype: string;
  payload?: Record<string, unknown> | null;
}

export class SystemEntry extends TranscriptEntry {
  override kind = EntryKind.SYSTEM;

  subtype: string;
  payload: Record<string, unknown>;

  constructor(data: SystemEntryData) {
    super(data);
    this.subtype = data.subtype ?? '';
    this.payload = data.payload ?? {};
  }
}
