import type { GenericEntry, ParsedTranscript } from './entries';
import { TranscriptFormat, TranscriptSource } from '../../transcript-analyzer';

/**
 * Validate and cast the server response to a `ParsedTranscript`.
 *
 * The server's `/api/v1/transcripts/{worker_type}` endpoint returns
 * `entry.to_dict()` for each entry — the keys match the discriminated-union
 * shapes in `entries.ts` exactly. We do a runtime check on `kind` and trust
 * the rest of the shape.
 *
 * Throws on malformed responses (missing `entries`, non-string `kind`, etc.)
 * so the calling hook can surface a parse error instead of silently
 * rendering garbage.
 */
export function parseTranscriptResponse(json: unknown): ParsedTranscript {
  if (!json || typeof json !== 'object') {
    throw new Error('parseTranscriptResponse: expected an object');
  }
  const obj = json as Record<string, unknown>;
  if (obj.ok === false) {
    throw new Error(`server: ${obj.error_code ?? 'UNKNOWN'} — ${obj.error ?? ''}`);
  }

  const entriesRaw = obj.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new Error('parseTranscriptResponse: missing entries array');
  }

  const entries: GenericEntry[] = entriesRaw.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`entry[${idx}]: not an object`);
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.kind !== 'string') {
      throw new Error(`entry[${idx}]: missing kind`);
    }
    return e as unknown as GenericEntry;
  });

  return {
    worker_type: String(obj.worker_type ?? ''),
    session_id: String(obj.session_id ?? ''),
    path: String(obj.path ?? ''),
    received: obj.received === true,
    transcript_format: Object.values(TranscriptFormat).includes(obj.transcript_format as TranscriptFormat)
      ? obj.transcript_format as TranscriptFormat
      : null,
    transcript_source: Object.values(TranscriptSource).includes(obj.transcript_source as TranscriptSource)
      ? obj.transcript_source as TranscriptSource
      : null,
    header: (obj.header as ParsedTranscript['header']) ?? {},
    entries,
  };
}
