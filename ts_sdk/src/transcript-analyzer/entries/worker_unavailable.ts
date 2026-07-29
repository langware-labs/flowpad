/**
 * WorkerUnavailableEntry — a normalized provider failure that can be
 * recovered by starting a chat with another configured worker.
 */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export type WorkerUnavailableReason = 'quota_exhausted' | 'rate_limited';

export interface WorkerUnavailableEntryData extends TranscriptEntryBase {
  reason: WorkerUnavailableReason;
  worker_type: string;
  provider_error: string;
  status_code: number | null;
  recoverable_with_alternative: boolean;
  message: string;
}

export class WorkerUnavailableEntry extends TranscriptEntry {
  override kind = EntryKind.WORKER_UNAVAILABLE;

  reason: WorkerUnavailableReason;
  worker_type: string;
  provider_error: string;
  status_code: number | null;
  recoverable_with_alternative: boolean;
  message: string;

  constructor(data: WorkerUnavailableEntryData) {
    super(data);
    this.reason = data.reason ?? '';
    this.worker_type = data.worker_type ?? data.worker ?? '';
    this.provider_error = data.provider_error ?? '';
    this.status_code = data.status_code ?? null;
    this.recoverable_with_alternative = data.recoverable_with_alternative ?? false;
    this.message = data.message ?? '';
  }
}
