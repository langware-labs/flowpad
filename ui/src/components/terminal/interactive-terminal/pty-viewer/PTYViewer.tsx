import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Loader2, X } from 'lucide-react';
import type { Shell, PtySequenceData, PtySequenceChunkMeta } from '@sdk';
import {
  PtyValidationStatus,
  buildViewerData,
  fetchReplayChunks,
  getXtermChunkCount,
  formatTimestamp,
  formatBytes,
  decodePreview,
  type PtyViewerData,
} from './pty-viewer-logic';

interface Props {
  open: boolean;
  onClose: () => void;
  shell: Shell | null;
}

const STATUS_COLORS: Record<PtyValidationStatus, string> = {
  [PtyValidationStatus.MATCH]: 'text-emerald-400',
  [PtyValidationStatus.MISMATCH]: 'text-red-400',
  [PtyValidationStatus.NO_DATA]: 'text-muted-foreground',
  [PtyValidationStatus.PRE_ALIGNMENT]: 'text-yellow-400',
};

const STATUS_LABELS: Record<PtyValidationStatus, string> = {
  [PtyValidationStatus.MATCH]: 'OK',
  [PtyValidationStatus.MISMATCH]: 'MISMATCH',
  [PtyValidationStatus.NO_DATA]: '\u2014',
  [PtyValidationStatus.PRE_ALIGNMENT]: 'pre-align',
};

/** Decode full chunk b64 to a readable representation with escape sequences shown. */
function decodeFullChunk(b64: string): string {
  try {
    const bytes = atob(b64);
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes.charCodeAt(i);
      if (c === 0x1b) {
        result += '\x1b[38;5;208m'; // orange for escape sequences
        result += 'ESC';
        // Read the full escape sequence
        i++;
        if (i < bytes.length && bytes[i] === '[') {
          result += '[';
          i++;
          while (i < bytes.length && bytes.charCodeAt(i) >= 0x20 && bytes.charCodeAt(i) <= 0x3f) {
            result += bytes[i];
            i++;
          }
          if (i < bytes.length) result += bytes[i]; // final byte
        } else if (i < bytes.length) {
          result += bytes[i];
        }
        result += '\x1b[0m';
      } else if (c === 0x0d) {
        result += '\x1b[38;5;245m\\r\x1b[0m';
      } else if (c === 0x0a) {
        result += '\x1b[38;5;245m\\n\x1b[0m\n';
      } else if (c < 32) {
        result += `\x1b[38;5;245m[${c.toString(16).padStart(2, '0')}]\x1b[0m`;
      } else {
        result += bytes[i];
      }
    }
    return result;
  } catch {
    return '(decode error)';
  }
}

/** Decode chunk to plain text: strip all ANSI escape sequences, show only printable chars. */
function decodePlainText(b64: string): string {
  try {
    const bytes = atob(b64);
    let result = '';
    let i = 0;
    while (i < bytes.length) {
      const c = bytes.charCodeAt(i);
      if (c === 0x1b) {
        // Skip escape sequence
        i++;
        if (i < bytes.length && bytes[i] === '[') {
          i++;
          while (i < bytes.length && bytes.charCodeAt(i) >= 0x20 && bytes.charCodeAt(i) <= 0x3f) i++;
          if (i < bytes.length) i++; // skip final byte
        } else if (i < bytes.length) {
          i++;
        }
      } else if (c === 0x0d) {
        i++;
      } else if (c === 0x0a) {
        result += '\n';
        i++;
      } else if (c >= 32 && c < 127) {
        result += bytes[i];
        i++;
      } else {
        i++;
      }
    }
    return result;
  } catch {
    return '(decode error)';
  }
}

export function PTYViewer({ open, onClose, shell }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PtyViewerData | null>(null);
  const [replayData, setReplayData] = useState<PtySequenceData | null>(null);
  const [xtermChunkCount, setXtermChunkCount] = useState(0);
  const [selectedChunk, setSelectedChunk] = useState<PtySequenceChunkMeta | null>(null);

  useEffect(() => {
    if (!open || !shell) return;
    setLoading(true);
    setError(null);
    setSelectedChunk(null);

    (async () => {
      try {
        const replay = await fetchReplayChunks(shell);
        setReplayData(replay);
        setXtermChunkCount(getXtermChunkCount(shell));

        let ptyFileBytes: Uint8Array | null = null;
        if (replay.pty_file_b64) {
          const bin = atob(replay.pty_file_b64);
          ptyFileBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) ptyFileBytes[i] = bin.charCodeAt(i);
        }

        const viewerData = buildViewerData(replay, ptyFileBytes);
        setData(viewerData);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, shell]);

  const baseTimestamp = replayData?.chunks?.[0]?.timestamp;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setSelectedChunk(null); onClose(); } }}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            PTY Viewer
            {shell && <span className="text-xs text-muted-foreground font-mono">{shell.id.slice(0, 8)}</span>}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            {/* Summary stats */}
            <div className="flex gap-4 text-xs text-muted-foreground border-b pb-2 mb-2">
              <span>Replay: <b className="text-foreground">{data.totalChunks}</b> chunks ({formatBytes(data.totalSizeBytes)})</span>
              <span>xterm: <b className="text-foreground">{xtermChunkCount}</b> chunks</span>
              {data.ptyFileSize > 0 && <span>PTY file: <b className="text-foreground">{formatBytes(data.ptyFileSize)}</b></span>}
              {data.alignmentSeq >= 0 && (
                <span>Aligned at seq <b className="text-foreground">{data.alignmentSeq}</b></span>
              )}
            </div>

            <div className="flex flex-1 min-h-0 gap-2">
              {/* Chunk table */}
              <div className="flex-1 overflow-auto min-h-0">
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left px-2 py-1 w-16">seq</th>
                      <th className="text-left px-2 py-1 w-24">time</th>
                      <th className="text-right px-2 py-1 w-16">size</th>
                      <th className="text-center px-2 py-1 w-20">status</th>
                      <th className="text-left px-2 py-1">preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => {
                      const chunk = replayData?.chunks.find(c => c.seq === row.seq);
                      const isSelected = selectedChunk?.seq === row.seq;
                      return (
                        <tr
                          key={row.seq}
                          className={`border-b border-border/30 cursor-pointer ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                          onClick={() => setSelectedChunk(chunk ?? null)}
                        >
                          <td className="px-2 py-0.5">{row.seq}</td>
                          <td className="px-2 py-0.5">{formatTimestamp(row.timestamp, baseTimestamp)}</td>
                          <td className="px-2 py-0.5 text-right">{formatBytes(row.size)}</td>
                          <td className={`px-2 py-0.5 text-center ${STATUS_COLORS[row.validationStatus]}`}>
                            {STATUS_LABELS[row.validationStatus]}
                          </td>
                          <td className="px-2 py-0.5 truncate max-w-[300px] text-muted-foreground">
                            {chunk?.preview_b64 ? decodePreview(chunk.preview_b64) : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Detail panel — shows full decoded content of selected chunk */}
              {selectedChunk && (
                <div className="w-[400px] flex flex-col border-l pl-2 min-h-0">
                  <div className="flex items-center justify-between text-xs text-muted-foreground pb-1 border-b mb-1">
                    <span>
                      Chunk <b className="text-foreground">{selectedChunk.seq}</b> — {formatBytes(selectedChunk.size)}
                    </span>
                    <button onClick={() => setSelectedChunk(null)} className="hover:text-foreground">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-auto min-h-0 whitespace-pre-wrap break-all text-xs font-mono bg-muted/20 rounded p-2">
                    {decodePlainText(selectedChunk.data_b64)}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
