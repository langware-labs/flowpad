import type { Shell, PtySequenceChunkMeta, PtySequenceData } from '@sdk';

export const enum PtyValidationStatus {
  MATCH = 'match',
  MISMATCH = 'mismatch',
  NO_DATA = 'no_data',
  PRE_ALIGNMENT = 'pre_alignment',
}

export interface PtyViewerRow {
  seq: number;
  timestamp: number;
  size: number;
  validationStatus: PtyValidationStatus;
  mismatchOffset?: number;
}

export interface PtyViewerData {
  rows: PtyViewerRow[];
  totalChunks: number;
  totalSizeBytes: number;
  ptyFileSize: number;
  alignmentOffset: number;
  alignmentSeq: number;
}

/** Decode a base64 string to Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Fetch replay buffer chunks + PTY file from server. */
export async function fetchReplayChunks(shell: Shell): Promise<PtySequenceData> {
  return shell.fetchPtySequence();
}

/** Count xterm chunks in browser memory. */
export function getXtermChunkCount(shell: Shell): number {
  return shell.getPtyChunks().length;
}

const ALIGNMENT_MATCH_LENGTH = 32;

/**
 * Find alignment point: search for the LAST occurrence of the first large
 * chunk's data in the PTY file (searching from end avoids false positives
 * from earlier redraws of similar content). Verifies the alignment by
 * checking that the next chunk also matches at the expected offset.
 */
export function findAlignmentPoint(
  ptyFileBytes: Uint8Array,
  chunks: PtySequenceChunkMeta[],
): { fileOffset: number; chunkIdx: number } | null {
  for (let i = 0; i < chunks.length - 1; i++) {
    const chunk = chunks[i];
    const chunkBytes = b64ToBytes(chunk.data_b64);
    if (chunkBytes.length < ALIGNMENT_MATCH_LENGTH) continue;

    const nextChunk = chunks[i + 1];
    const nextBytes = b64ToBytes(nextChunk.data_b64);

    const matchLen = Math.min(chunkBytes.length, ALIGNMENT_MATCH_LENGTH);

    // Search from end of PTY file backward to find the LAST match
    for (let j = ptyFileBytes.length - matchLen; j >= 0; j--) {
      let matched = true;
      for (let k = 0; k < matchLen; k++) {
        if (ptyFileBytes[j + k] !== chunkBytes[k]) { matched = false; break; }
      }
      if (!matched) continue;

      // Verify: does the full chunk match?
      let fullMatch = true;
      if (j + chunkBytes.length <= ptyFileBytes.length) {
        for (let k = 0; k < chunkBytes.length; k++) {
          if (ptyFileBytes[j + k] !== chunkBytes[k]) { fullMatch = false; break; }
        }
      } else {
        fullMatch = false;
      }
      if (!fullMatch) continue;

      // Verify: does the NEXT chunk also match at the expected offset?
      const nextOffset = j + chunkBytes.length;
      const nextMatchLen = Math.min(nextBytes.length, ALIGNMENT_MATCH_LENGTH);
      if (nextOffset + nextMatchLen > ptyFileBytes.length) continue;
      let nextOk = true;
      for (let k = 0; k < nextMatchLen; k++) {
        if (ptyFileBytes[nextOffset + k] !== nextBytes[k]) { nextOk = false; break; }
      }
      if (!nextOk) continue;

      return { fileOffset: j, chunkIdx: i };
    }
  }
  return null;
}

/**
 * Validate a single chunk's full data against the PTY file at a given offset.
 * Returns MATCH if all bytes match, MISMATCH with the offset of the first difference.
 */
function validateChunk(
  ptyFileBytes: Uint8Array,
  fileOffset: number,
  chunkB64: string,
): { status: PtyValidationStatus; mismatchOffset?: number } {
  const chunkBytes = b64ToBytes(chunkB64);
  if (fileOffset + chunkBytes.length > ptyFileBytes.length) {
    return { status: PtyValidationStatus.NO_DATA };
  }
  for (let i = 0; i < chunkBytes.length; i++) {
    if (ptyFileBytes[fileOffset + i] !== chunkBytes[i]) {
      return { status: PtyValidationStatus.MISMATCH, mismatchOffset: i };
    }
  }
  return { status: PtyValidationStatus.MATCH };
}

/** Build viewer rows with byte-by-byte validation against PTY file. */
export function buildViewerData(
  replayChunks: PtySequenceData,
  ptyFileBytes: Uint8Array | null,
): PtyViewerData {
  const chunks = replayChunks.chunks;

  let alignmentOffset = -1;
  let alignmentSeq = -1;
  let alignmentChunkIdx = -1;

  if (ptyFileBytes && chunks.length > 0) {
    const alignment = findAlignmentPoint(ptyFileBytes, chunks);
    if (alignment) {
      alignmentOffset = alignment.fileOffset;
      alignmentChunkIdx = alignment.chunkIdx;
      alignmentSeq = chunks[alignment.chunkIdx].seq;
    }
  }

  // Walk through chunks from alignment point, tracking file offset
  let fileOffset = alignmentOffset;

  const rows: PtyViewerRow[] = chunks.map((chunk, idx) => {
    if (ptyFileBytes === null || alignmentChunkIdx < 0) {
      return { seq: chunk.seq, timestamp: chunk.timestamp, size: chunk.size, validationStatus: PtyValidationStatus.NO_DATA };
    }
    if (idx < alignmentChunkIdx) {
      return { seq: chunk.seq, timestamp: chunk.timestamp, size: chunk.size, validationStatus: PtyValidationStatus.PRE_ALIGNMENT };
    }

    const result = validateChunk(ptyFileBytes, fileOffset, chunk.data_b64);
    fileOffset += chunk.size;

    return {
      seq: chunk.seq,
      timestamp: chunk.timestamp,
      size: chunk.size,
      validationStatus: result.status,
      mismatchOffset: result.mismatchOffset,
    };
  });

  return {
    rows,
    totalChunks: replayChunks.total_chunks,
    totalSizeBytes: replayChunks.total_size_bytes,
    ptyFileSize: ptyFileBytes?.length ?? 0,
    alignmentOffset,
    alignmentSeq,
  };
}

/** Format timestamp as relative time from base. */
export function formatTimestamp(timestamp: number, baseTimestamp?: number): string {
  if (baseTimestamp) {
    const delta = timestamp - baseTimestamp;
    return `+${(delta * 1000).toFixed(0)}ms`;
  }
  const d = new Date(timestamp * 1000);
  return d.toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
}

/** Format bytes as human-readable. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Decode preview bytes to readable string with escaped non-printable chars. */
export function decodePreview(b64: string): string {
  try {
    const bytes = atob(b64);
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes.charCodeAt(i);
      if (c === 0x1b) result += 'ESC';
      else if (c === 0x0d) result += '\\r';
      else if (c === 0x0a) result += '\\n';
      else if (c >= 32 && c < 127) result += bytes[i];
      else result += `[${c.toString(16).padStart(2, '0')}]`;
    }
    return result;
  } catch {
    return '(decode error)';
  }
}
