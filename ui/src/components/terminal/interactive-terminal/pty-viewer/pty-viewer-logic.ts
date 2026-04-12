import type { Shell, PtySequenceChunkMeta, PtySequenceData } from '@sdk';

export const enum PtyValidationStatus {
  MATCH = 'match',
  MISMATCH = 'mismatch',
  NO_DATA = 'no_data',
  PRE_ALIGNMENT = 'pre_alignment',
}

/** A detected terminal control event with its name and optional parameter data. */
export interface PtyEvent {
  name: string;
  /** Raw parameter string for parametric sequences, e.g. "10;5" for CURSOR-POS, title text for OSC-TITLE. */
  data?: string;
}

export interface PtyViewerRow {
  seq: number;
  timestamp: number;
  size: number;
  validationStatus: PtyValidationStatus;
  mismatchOffset?: number;
  /** Named control sequences detected in this chunk, with parameter data. */
  namedEvents: PtyEvent[];
  /** True if any detected event is high-impact (screen clear, mode switch, etc.). */
  hasHighImpactEvent: boolean;
  /** True if chunk contains the Ink/Claude Code full-render cluster: CLR-SCROLLBACK + CLR-SCREEN + CURSOR-HOME. */
  isRenderCycle: boolean;
  /** Chunk contains ESC[3J specifically. */
  hasClearScrollback: boolean;
  /** Chunk is present in _pty.chunks (xterm memory). */
  inXterm: boolean;
}

export interface PtyViewerData {
  rows: PtyViewerRow[];
  totalChunks: number;
  totalSizeBytes: number;
  ptyFileSize: number;
  alignmentOffset: number;
  alignmentSeq: number;
  /** Number of replay chunks NOT present in _pty.chunks. */
  xtermGapCount: number;
  /** Highest seq present in _pty.chunks (0 = none). */
  xtermLastSeq: number;
  /** Seqs of chunks that contain ESC[3J. */
  clearScrollbackSeqs: number[];
}

// ── Sequence detection ────────────────────────────────────────────────────────

/**
 * Fixed-byte sequences: each entry is a complete escape sequence as a byte array.
 * Matched by literal scan — no parameters, no ambiguity.
 */
const FIXED_SEQUENCES: Array<{ bytes: number[]; name: string; highImpact: boolean }> = [
  // Screen clear / erase
  { bytes: [0x1b, 0x5b, 0x33, 0x4a], name: 'CLR-SCROLLBACK',  highImpact: true  }, // ESC[3J ← critical
  { bytes: [0x1b, 0x5b, 0x32, 0x4a], name: 'CLR-SCREEN',      highImpact: true  }, // ESC[2J
  { bytes: [0x1b, 0x5b, 0x31, 0x4a], name: 'ERASE-TO-BOF',    highImpact: true  }, // ESC[1J
  { bytes: [0x1b, 0x5b, 0x4a],       name: 'ERASE-TO-EOF',    highImpact: true  }, // ESC[J
  { bytes: [0x1b, 0x5b, 0x32, 0x4b], name: 'ERASE-LINE',      highImpact: true  }, // ESC[2K
  { bytes: [0x1b, 0x5b, 0x31, 0x4b], name: 'ERASE-BOL',       highImpact: false }, // ESC[1K
  { bytes: [0x1b, 0x5b, 0x4b],       name: 'ERASE-EOL',       highImpact: false }, // ESC[K
  { bytes: [0x1b, 0x63],             name: 'FULL-RESET',       highImpact: true  }, // ESC c (RIS)

  // Alternate screen
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68], name: 'ALT-SCREEN+', highImpact: true }, // ESC[?1049h
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c], name: 'ALT-SCREEN-', highImpact: true }, // ESC[?1049l
  { bytes: [0x1b, 0x5b, 0x3f, 0x34, 0x37, 0x68],             name: 'ALT-BUF+',    highImpact: true }, // ESC[?47h
  { bytes: [0x1b, 0x5b, 0x3f, 0x34, 0x37, 0x6c],             name: 'ALT-BUF-',    highImpact: true }, // ESC[?47l

  // Cursor home (zero-param)
  { bytes: [0x1b, 0x5b, 0x48], name: 'CURSOR-HOME', highImpact: true }, // ESC[H

  // Cursor visibility
  { bytes: [0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68], name: 'CURSOR+',      highImpact: false }, // ESC[?25h
  { bytes: [0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c], name: 'CURSOR-',      highImpact: false }, // ESC[?25l
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x32, 0x68], name: 'CURSOR-BLINK+', highImpact: false }, // ESC[?12h
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x32, 0x6c], name: 'CURSOR-BLINK-', highImpact: false }, // ESC[?12l

  // Cursor style (DECSCUSR)
  { bytes: [0x1b, 0x5b, 0x30, 0x20, 0x71], name: 'CURSOR-DEFAULT',      highImpact: false }, // ESC[0 q
  { bytes: [0x1b, 0x5b, 0x31, 0x20, 0x71], name: 'CURSOR-BLINK-BLOCK',  highImpact: false }, // ESC[1 q
  { bytes: [0x1b, 0x5b, 0x32, 0x20, 0x71], name: 'CURSOR-BLOCK',        highImpact: false }, // ESC[2 q
  { bytes: [0x1b, 0x5b, 0x35, 0x20, 0x71], name: 'CURSOR-BLINK-BAR',    highImpact: false }, // ESC[5 q
  { bytes: [0x1b, 0x5b, 0x36, 0x20, 0x71], name: 'CURSOR-BAR',          highImpact: false }, // ESC[6 q

  // Cursor save / restore (DEC)
  { bytes: [0x1b, 0x37], name: 'CURSOR-SAVE',    highImpact: false }, // ESC 7
  { bytes: [0x1b, 0x38], name: 'CURSOR-RESTORE', highImpact: false }, // ESC 8

  // Application cursor keys
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x68], name: 'APP-CURSOR+', highImpact: false }, // ESC[?1h
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x6c], name: 'APP-CURSOR-', highImpact: false }, // ESC[?1l

  // Auto-wrap
  { bytes: [0x1b, 0x5b, 0x3f, 0x37, 0x68], name: 'WRAP+', highImpact: false }, // ESC[?7h
  { bytes: [0x1b, 0x5b, 0x3f, 0x37, 0x6c], name: 'WRAP-', highImpact: false }, // ESC[?7l

  // Bracketed paste
  { bytes: [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68], name: 'BRACKET-PASTE+', highImpact: false }, // ESC[?2004h
  { bytes: [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x6c], name: 'BRACKET-PASTE-', highImpact: false }, // ESC[?2004l

  // Mouse
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x30, 0x30, 0x68], name: 'MOUSE-BASIC+', highImpact: false }, // ESC[?1000h
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x30, 0x30, 0x6c], name: 'MOUSE-BASIC-', highImpact: false }, // ESC[?1000l
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x30, 0x36, 0x68], name: 'MOUSE-SGR+',   highImpact: false }, // ESC[?1006h
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x30, 0x36, 0x6c], name: 'MOUSE-SGR-',   highImpact: false }, // ESC[?1006l

  // Focus events
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x30, 0x34, 0x68], name: 'FOCUS-EVENT+', highImpact: false }, // ESC[?1004h
  { bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x30, 0x34, 0x6c], name: 'FOCUS-EVENT-', highImpact: false }, // ESC[?1004l

  // Synchronized output (DEC 2026) — Claude Code emits these around every render
  { bytes: [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68], name: 'SYNC-UPDATE+', highImpact: true }, // ESC[?2026h
  { bytes: [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c], name: 'SYNC-UPDATE-', highImpact: true }, // ESC[?2026l

  // C1 equivalents (7-bit)
  { bytes: [0x1b, 0x44], name: 'IND', highImpact: false }, // ESC D — index (scroll up one)
  { bytes: [0x1b, 0x4d], name: 'RI',  highImpact: true  }, // ESC M — reverse index
  { bytes: [0x1b, 0x45], name: 'NEL', highImpact: false }, // ESC E — next line

  // SGR reset (zero-param variants — common enough to name)
  { bytes: [0x1b, 0x5b, 0x6d],       name: 'SGR-RESET',  highImpact: false }, // ESC[m
  { bytes: [0x1b, 0x5b, 0x30, 0x6d], name: 'SGR-RESET',  highImpact: false }, // ESC[0m

  // Application cursor key responses (SS3)
  { bytes: [0x1b, 0x4f, 0x41], name: 'KEY-UP',    highImpact: false }, // ESC O A
  { bytes: [0x1b, 0x4f, 0x42], name: 'KEY-DOWN',  highImpact: false }, // ESC O B
  { bytes: [0x1b, 0x4f, 0x43], name: 'KEY-RIGHT', highImpact: false }, // ESC O C
  { bytes: [0x1b, 0x4f, 0x44], name: 'KEY-LEFT',  highImpact: false }, // ESC O D
  { bytes: [0x1b, 0x4f, 0x48], name: 'KEY-HOME',  highImpact: false }, // ESC O H
  { bytes: [0x1b, 0x4f, 0x46], name: 'KEY-END',   highImpact: false }, // ESC O F
  { bytes: [0x1b, 0x4f, 0x50], name: 'KEY-F1',    highImpact: false }, // ESC O P
  { bytes: [0x1b, 0x4f, 0x51], name: 'KEY-F2',    highImpact: false }, // ESC O Q
  { bytes: [0x1b, 0x4f, 0x52], name: 'KEY-F3',    highImpact: false }, // ESC O R
  { bytes: [0x1b, 0x4f, 0x53], name: 'KEY-F4',    highImpact: false }, // ESC O S
];

/** Set of high-impact event names for chip styling in the UI. */
export const HIGH_IMPACT_EVENTS: Set<string> = new Set(
  FIXED_SEQUENCES.filter((s) => s.highImpact).map((s) => s.name).concat([
    // Parametric events that are high-impact
    'SCROLL-REGION', 'CURSOR-POS', 'OSC-TITLE', 'OSC-CWD', 'OSC-SHELL',
    'CURSOR-UP', 'CURSOR-DOWN',
  ])
);

/** Scan b64 for fixed (non-parametric) named sequences. Returns PtyEvent[]. */
function detectFixedEvents(bin: string): PtyEvent[] {
  const seen = new Set<string>();
  const found: PtyEvent[] = [];
  for (const { bytes, name } of FIXED_SEQUENCES) {
    if (seen.has(name)) continue;
    outer: for (let i = 0; i <= bin.length - bytes.length; i++) {
      for (let k = 0; k < bytes.length; k++) {
        if (bin.charCodeAt(i + k) !== bytes[k]) continue outer;
      }
      seen.add(name);
      found.push({ name });
      break;
    }
  }
  return found;
}

/**
 * Parse parametric CSI / OSC sequences using a state machine.
 * Returns PtyEvent[] with name + data (the actual parameter values).
 */
function detectParametricEvents(bin: string): PtyEvent[] {
  const found: PtyEvent[] = [];
  // Track which parametric names were seen (deduplicate)
  const seen = new Set<string>();
  let i = 0;

  const add = (name: string, data?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    found.push({ name, data });
  };

  while (i < bin.length) {
    if (bin.charCodeAt(i) !== 0x1b) { i++; continue; }
    i++; // consume ESC
    if (i >= bin.length) break;

    const introducer = bin.charCodeAt(i);

    if (introducer === 0x5b) {
      // CSI: ESC [ [?] params... finalByte
      i++;
      let isPrivate = false;
      if (i < bin.length && bin.charCodeAt(i) === 0x3f) { isPrivate = true; i++; }
      let params = '';
      while (i < bin.length) {
        const c = bin.charCodeAt(i);
        if (c >= 0x30 && c <= 0x3f) { params += bin[i]; i++; }
        else break;
      }
      const finalByte = i < bin.length ? bin.charCodeAt(i) : -1;
      if (finalByte >= 0) i++;

      if (!isPrivate) {
        switch (finalByte) {
          case 0x48: // H — cursor position (with params); zero-param CURSOR-HOME handled by fixed
            if (params.length > 0) add('CURSOR-POS', params); // e.g. "10;5"
            break;
          case 0x72: // r — DECSTBM scroll region
            if (params.includes(';')) add('SCROLL-REGION', params); // e.g. "1;24"
            break;
          case 0x41: add('CURSOR-UP',   params || '1'); break; // e.g. "3"
          case 0x42: add('CURSOR-DOWN', params || '1'); break;
          case 0x43: add('CURSOR-FWD',  params || '1'); break;
          case 0x44: add('CURSOR-BACK', params || '1'); break;
          case 0x47: add('CURSOR-COL',  params || '1'); break; // G
          case 0x4c: add('INSERT-LINES', params || '1'); break; // L
          case 0x4d: add('DELETE-LINES', params || '1'); break; // M
          case 0x53: add('SCROLL-UP',  params || '1'); break; // S
          case 0x54: add('SCROLL-DN',  params || '1'); break; // T
          case 0x6d: { // m — SGR
            if (params.includes('38;2') || params.includes('48;2')) add('SGR-RGB');
            else if (params.includes('38;5') || params.includes('48;5')) add('SGR-256');
            // SGR-RESET handled by fixed scan
            break;
          }
          case 0x6e: if (params === '6') add('CURSOR-QUERY'); break; // DSR
          case 0x66: if (params.includes(';')) add('CURSOR-POS', params); break; // HVP = H
        }
      }
    } else if (introducer === 0x5d) {
      // OSC: ESC ] n ; payload ST
      i++;
      let osc = '';
      while (i < bin.length) {
        const c = bin.charCodeAt(i);
        if (c === 0x07) { i++; break; }
        if (c === 0x1b && i + 1 < bin.length && bin.charCodeAt(i + 1) === 0x5c) { i += 2; break; }
        osc += bin[i++];
      }
      const semi = osc.indexOf(';');
      const oscNumStr = semi >= 0 ? osc.slice(0, semi) : osc;
      const oscPayload = semi >= 0 ? osc.slice(semi + 1) : '';
      const oscNum = parseInt(oscNumStr, 10);
      const payloadPreview = oscPayload.slice(0, 60); // cap for display
      switch (oscNum) {
        case 0: case 1: case 2: add('OSC-TITLE', payloadPreview); break;
        case 7:                 add('OSC-CWD', payloadPreview);   break;
        case 52:                add('OSC-CLIPBOARD');              break;
        case 133:               add('OSC-SHELL', oscPayload.slice(0, 4)); break; // A/B/C/D
        default: if (!isNaN(oscNum)) add(`OSC-${oscNum}`, payloadPreview.slice(0, 20));
      }
    } else if (introducer === 0x50) {
      // DCS — skip to terminator
      i++;
      while (i < bin.length) {
        if (bin.charCodeAt(i) === 0x07) { i++; break; }
        if (bin.charCodeAt(i) === 0x1b && i + 1 < bin.length && bin.charCodeAt(i + 1) === 0x5c) { i += 2; break; }
        i++;
      }
      add('DCS');
    } else {
      // Two-byte ESC X — already covered by fixed scan if notable
    }
  }

  return found;
}

/**
 * Detect all named events in a b64-encoded chunk.
 * Merges fixed-byte scan (fast, exact) with parametric CSI/OSC parser.
 * Deduplicates by name — first occurrence wins.
 */
export function detectNamedEvents(b64: string): PtyEvent[] {
  try {
    const bin = atob(b64);
    const fixed = detectFixedEvents(bin);
    const parametric = detectParametricEvents(bin);
    const seen = new Set(fixed.map((e) => e.name));
    return [...fixed, ...parametric.filter((e) => !seen.has(e.name))];
  } catch { return []; }
}

/**
 * Detect the Ink / Claude Code full-render cycle:
 * CLR-SCROLLBACK + CLR-SCREEN + CURSOR-HOME in the same chunk.
 * Claude Code (using Ink) emits: SYNC-UPDATE- → SYNC-UPDATE+ → CLR-SCREEN → CLR-SCROLLBACK → CURSOR-HOME.
 */
export function detectRenderCycle(events: PtyEvent[]): boolean {
  const names = new Set(events.map((e) => e.name));
  return names.has('CLR-SCROLLBACK') && names.has('CLR-SCREEN') && names.has('CURSOR-HOME');
}

/** Return true if the b64 chunk contains ESC[3J (clear scrollback). */
export function containsClearScrollback(b64: string): boolean {
  try {
    const bin = atob(b64);
    for (let i = 0; i <= bin.length - 4; i++) {
      if (bin.charCodeAt(i) === 0x1b && bin.charCodeAt(i+1) === 0x5b &&
          bin.charCodeAt(i+2) === 0x33 && bin.charCodeAt(i+3) === 0x4a) return true;
    }
    return false;
  } catch { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch replay buffer chunks + PTY file from server. */
export async function fetchReplayChunks(shell: Shell): Promise<PtySequenceData> {
  return shell.fetchPtySequence();
}

/** Count xterm chunks in browser memory. */
export function getXtermChunkCount(shell: Shell): number {
  return shell.ptyConnection.getSortedChunks().length;
}

/** Return the set of seq numbers currently in _pty.chunks (xterm memory). */
export function getXtermSeqs(shell: Shell): Set<number> {
  return new Set(shell.ptyConnection.getSortedChunks().map((c) => c.seq));
}

/** Format timestamp as relative time from base (ms), or absolute time. */
export function formatTimestamp(timestamp: number, baseTimestamp?: number): string {
  if (baseTimestamp !== undefined) {
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

/**
 * Decode b64 chunk to plain readable text — strips ALL escape sequences.
 * Use this for the preview column so it shows only what a human would read.
 */
export function decodePlainText(b64: string): string {
  try {
    const bin = atob(b64);
    let result = '';
    let i = 0;
    while (i < bin.length) {
      const c = bin.charCodeAt(i);
      if (c === 0x1b) {
        // Skip full escape sequence
        i++;
        if (i < bin.length) {
          const intro = bin.charCodeAt(i);
          if (intro === 0x5b || intro === 0x5d || intro === 0x50) {
            // CSI / OSC / DCS — skip to terminator
            i++;
            while (i < bin.length) {
              const e = bin.charCodeAt(i);
              if (e === 0x07) { i++; break; } // BEL
              if (e === 0x1b && i + 1 < bin.length && bin.charCodeAt(i+1) === 0x5c) { i += 2; break; } // ESC \
              if (intro === 0x5b && e >= 0x40 && e <= 0x7e) { i++; break; } // CSI final byte
              i++;
            }
          } else {
            i++; // two-byte ESC sequence
          }
        }
      } else if (c === 0x0d) {
        i++; // CR — skip (often paired with LF)
      } else if (c === 0x0a) {
        result += '\n'; i++;
      } else if (c >= 0x20 && c < 0x7f) {
        result += bin[i]; i++;
      } else {
        i++; // other control chars — skip
      }
    }
    return result;
  } catch { return '(decode error)'; }
}

// ── PTY file alignment ────────────────────────────────────────────────────────

const ALIGNMENT_MATCH_LENGTH = 32;

/**
 * Find alignment point: search for the LAST occurrence of the first large
 * chunk's data in the PTY file (searching from end avoids false positives
 * from earlier redraws of similar content). Verifies alignment by checking
 * that the next chunk also matches at the expected offset.
 */
export function findAlignmentPoint(
  ptyFileBytes: Uint8Array,
  chunks: PtySequenceChunkMeta[],
): { fileOffset: number; chunkIdx: number } | null {
  for (let i = 0; i < chunks.length - 1; i++) {
    const chunk = chunks[i];
    const chunkBytes = _b64ToBytes(chunk.data_b64);
    if (chunkBytes.length < ALIGNMENT_MATCH_LENGTH) continue;

    const nextChunk = chunks[i + 1];
    const nextBytes = _b64ToBytes(nextChunk.data_b64);
    const matchLen = Math.min(chunkBytes.length, ALIGNMENT_MATCH_LENGTH);

    for (let j = ptyFileBytes.length - matchLen; j >= 0; j--) {
      let matched = true;
      for (let k = 0; k < matchLen; k++) {
        if (ptyFileBytes[j + k] !== chunkBytes[k]) { matched = false; break; }
      }
      if (!matched) continue;

      let fullMatch = true;
      if (j + chunkBytes.length <= ptyFileBytes.length) {
        for (let k = 0; k < chunkBytes.length; k++) {
          if (ptyFileBytes[j + k] !== chunkBytes[k]) { fullMatch = false; break; }
        }
      } else { fullMatch = false; }
      if (!fullMatch) continue;

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

function validateChunk(
  ptyFileBytes: Uint8Array,
  fileOffset: number,
  chunkB64: string,
): { status: PtyValidationStatus; mismatchOffset?: number } {
  const chunkBytes = _b64ToBytes(chunkB64);
  if (fileOffset + chunkBytes.length > ptyFileBytes.length) return { status: PtyValidationStatus.NO_DATA };
  for (let i = 0; i < chunkBytes.length; i++) {
    if (ptyFileBytes[fileOffset + i] !== chunkBytes[i]) return { status: PtyValidationStatus.MISMATCH, mismatchOffset: i };
  }
  return { status: PtyValidationStatus.MATCH };
}

function _b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Build viewer data ─────────────────────────────────────────────────────────

/** Build viewer rows with event detection and byte-by-byte PTY file validation. */
export function buildViewerData(
  replayChunks: PtySequenceData,
  ptyFileBytes: Uint8Array | null,
  xtermSeqs: Set<number> = new Set(),
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

  let fileOffset = alignmentOffset;
  const clearScrollbackSeqs: number[] = [];

  const rows: PtyViewerRow[] = chunks.map((chunk, idx) => {
    const namedEvents = detectNamedEvents(chunk.data_b64);
    const eventNames = namedEvents.map((e) => e.name);
    const hasClearScrollback = eventNames.includes('CLR-SCROLLBACK');
    if (hasClearScrollback) clearScrollbackSeqs.push(chunk.seq);
    const isRenderCycle = detectRenderCycle(namedEvents);
    const hasHighImpactEvent = isRenderCycle || eventNames.some((n) => HIGH_IMPACT_EVENTS.has(n));
    const inXterm = xtermSeqs.has(chunk.seq);

    let validationStatus = PtyValidationStatus.NO_DATA;
    let mismatchOffset: number | undefined;

    if (ptyFileBytes !== null && alignmentChunkIdx >= 0) {
      if (idx < alignmentChunkIdx) {
        validationStatus = PtyValidationStatus.PRE_ALIGNMENT;
      } else {
        const result = validateChunk(ptyFileBytes, fileOffset, chunk.data_b64);
        validationStatus = result.status;
        mismatchOffset = result.mismatchOffset;
        fileOffset += chunk.size;
      }
    }

    return { seq: chunk.seq, timestamp: chunk.timestamp, size: chunk.size, validationStatus, mismatchOffset, namedEvents, hasHighImpactEvent, isRenderCycle, hasClearScrollback, inXterm };
  });

  const xtermSeqArr = [...xtermSeqs].sort((a, b) => a - b);
  const xtermLastSeq = xtermSeqArr.length > 0 ? xtermSeqArr[xtermSeqArr.length - 1] : 0;
  const xtermGapCount = chunks.filter((c) => !xtermSeqs.has(c.seq)).length;

  return { rows, totalChunks: replayChunks.total_chunks, totalSizeBytes: replayChunks.total_size_bytes, ptyFileSize: ptyFileBytes?.length ?? 0, alignmentOffset, alignmentSeq, xtermGapCount, xtermLastSeq, clearScrollbackSeqs };
}
