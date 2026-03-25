/**
 * createTranscriptRecord -- factory that dispatches raw entry dicts to the
 * correct TranscriptEntryFsRecord subclass.
 * Mirrors Python `create_transcript_entry` in
 * `flow_sdk/fs_records/claude/transcript_records/__init__.py`.
 */
import { TranscriptEntryFsRecord, type TranscriptEntryData } from './transcript-entry';
import { TranscriptProgressFsRecord } from './transcript-progress';
import { TranscriptToolUseFsRecord } from './transcript-tool-use';
import { TranscriptToolResultFsRecord } from './transcript-tool-result';
import { TranscriptFileSnapshotFsRecord } from './transcript-file-snapshot';
import { TranscriptQueueOperationFsRecord } from './transcript-queue-operation';
import { TranscriptSummaryFsRecord } from './transcript-summary';
import { TranscriptCustomTitleFsRecord } from './transcript-custom-title';
import { TranscriptPrLinkFsRecord } from './transcript-pr-link';
import type { FsRecordData } from '../../fs-record';

const ENTRY_TYPE_REGISTRY: Record<string, typeof TranscriptEntryFsRecord> = {
  'progress': TranscriptProgressFsRecord,
  'file-history-snapshot': TranscriptFileSnapshotFsRecord,
  'queue-operation': TranscriptQueueOperationFsRecord,
  'summary': TranscriptSummaryFsRecord,
  'custom-title': TranscriptCustomTitleFsRecord,
  'pr-link': TranscriptPrLinkFsRecord,
};

function isToolUseEntry(raw: TranscriptEntryData): boolean {
  if (raw.entry_type !== 'assistant') return false;
  const content = raw.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b: any) => typeof b === 'object' && b?.type === 'tool_use');
}

function isToolResultEntry(raw: TranscriptEntryData): boolean {
  if (raw.entry_type !== 'user') return false;
  const content = raw.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b: any) => typeof b === 'object' && b?.type === 'tool_result');
}

export function createTranscriptRecord(raw: TranscriptEntryData): TranscriptEntryFsRecord {
  const asData = raw as unknown as Partial<FsRecordData>;

  // Content-based dispatch (checked before the simple registry)
  if (isToolUseEntry(raw)) return new TranscriptToolUseFsRecord(asData);
  if (isToolResultEntry(raw)) return new TranscriptToolResultFsRecord(asData);

  const Cls = ENTRY_TYPE_REGISTRY[raw.entry_type] ?? TranscriptEntryFsRecord;
  return new Cls(asData);
}
