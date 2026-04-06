import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Check, ClipboardList, Loader2, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import type { Shell, PtySequenceData, PtySequenceChunkMeta } from '@sdk';
import {
  PtyValidationStatus,
  buildViewerData,
  fetchReplayChunks,
  getXtermChunkCount,
  formatTimestamp,
  formatBytes,
  decodePlainText,
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

// Tag categories for coloring
const TAG_COLORS = {
  clear: 'text-red-400',       // destructive: clear screen, scrollback
  cursor: 'text-blue-400',     // cursor movement: home, up, down, left, right
  sync: 'text-emerald-400',    // sync update: BSU/ESU
  scroll: 'text-orange-400',   // scroll region, scroll up/down
  mode: 'text-purple-400',     // mode set/reset, alt screen
  title: 'text-yellow-400',    // terminal title
  incomplete: 'text-pink-400', // split escape sequence
  text: '',                    // plain text — no color
} as const;

type TagCategory = keyof typeof TAG_COLORS;

interface Segment { text: string; category: TagCategory }

/** Translate a CSI sequence to { text, category }. Returns null only for SGR (colors). */
function csiToTag(params: string, final: string): Segment | null {
  const p = params || '0';
  // SGR (colors/styles) — any sequence ending in 'm', skip silently
  if (final === 'm') return null;
  // Incomplete sequence (no valid final byte) — show it
  if (!final || final.charCodeAt(0) < 0x40 || final.charCodeAt(0) > 0x7e) {
    return { text: `[INCOMPLETE: ESC[${params}${final}...]`, category: 'incomplete' };
  }
  switch (final) {
    case 'H': return { text: params === '' || params === '1;1' ? '[CURSOR HOME]' : `[CURSOR ${params}]`, category: 'cursor' };
    case 'J': {
      if (p === '2') return { text: '[CLEAR SCREEN]', category: 'clear' };
      if (p === '3') return { text: '[CLEAR SCROLLBACK]', category: 'clear' };
      if (p === '0') return { text: '[CLEAR BELOW]', category: 'clear' };
      if (p === '1') return { text: '[CLEAR ABOVE]', category: 'clear' };
      return { text: `[ERASE ${p}]`, category: 'clear' };
    }
    case 'K': {
      if (p === '0') return { text: '[CLEAR LINE RIGHT]', category: 'clear' };
      if (p === '2') return { text: '[CLEAR LINE]', category: 'clear' };
      return { text: `[ERASE LINE ${p}]`, category: 'clear' };
    }
    case 'A': return { text: `[UP ${p}]`, category: 'cursor' };
    case 'B': return { text: `[DOWN ${p}]`, category: 'cursor' };
    case 'C': return { text: `[RIGHT ${p}]`, category: 'cursor' };
    case 'D': return { text: `[LEFT ${p}]`, category: 'cursor' };
    case 'h': {
      if (params === '?2026') return { text: '[BEGIN SYNC UPDATE]', category: 'sync' };
      if (params === '?1049') return { text: '[ALT SCREEN ON]', category: 'mode' };
      if (params === '?25') return { text: '[CURSOR SHOW]', category: 'mode' };
      return { text: `[MODE ON ${params}]`, category: 'mode' };
    }
    case 'l': {
      if (params === '?2026') return { text: '[END SYNC UPDATE]', category: 'sync' };
      if (params === '?1049') return { text: '[ALT SCREEN OFF]', category: 'mode' };
      if (params === '?25') return { text: '[CURSOR HIDE]', category: 'mode' };
      return { text: `[MODE OFF ${params}]`, category: 'mode' };
    }
    case 'r': return { text: `[SCROLL REGION ${params}]`, category: 'scroll' };
    case 'S': return { text: `[SCROLL UP ${p}]`, category: 'scroll' };
    case 'T': return { text: `[SCROLL DOWN ${p}]`, category: 'scroll' };
    case 'G': return { text: `[COLUMN ${p}]`, category: 'cursor' };
    case 'd': return { text: `[ROW ${p}]`, category: 'cursor' };
    default: return { text: `[CSI ${params}${final}]`, category: 'mode' };
  }
}

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

/** Decode chunk into colored segments: text + human-readable tags for escape sequences. */
function decodeChunkSegments(b64: string): Segment[] {
  try {
    const bytes = atob(b64);
    const segments: Segment[] = [];
    let textBuf = '';
    const flushText = () => { if (textBuf) { segments.push({ text: textBuf, category: 'text' }); textBuf = ''; } };

    let i = 0;
    while (i < bytes.length) {
      const c = bytes.charCodeAt(i);
      if (c === 0x1b) {
        i++;
        if (i < bytes.length && bytes[i] === '[') {
          i++;
          let params = '';
          while (i < bytes.length && bytes.charCodeAt(i) >= 0x20 && bytes.charCodeAt(i) <= 0x3f) {
            params += bytes[i];
            i++;
          }
          const final = i < bytes.length ? bytes[i] : '';
          i++;
          const tag = csiToTag(params, final);
          if (tag) { flushText(); segments.push(tag); }
        } else if (i < bytes.length && bytes[i] === ']') {
          i++;
          let osc = '';
          while (i < bytes.length && bytes.charCodeAt(i) !== 0x07 && bytes.charCodeAt(i) !== 0x1b) {
            osc += bytes[i];
            i++;
          }
          if (i < bytes.length && bytes.charCodeAt(i) === 0x07) i++;
          flushText();
          if (osc.startsWith('0;')) segments.push({ text: `[SET TITLE: ${osc.slice(2)}]`, category: 'title' });
          else segments.push({ text: `[OSC ${osc.slice(0, 20)}]`, category: 'title' });
        } else if (i < bytes.length) {
          flushText();
          segments.push({ text: `[INCOMPLETE: ESC${bytes[i]}]`, category: 'incomplete' });
          i++;
        } else {
          // ESC at very end of chunk
          flushText();
          segments.push({ text: '[INCOMPLETE: ESC...]', category: 'incomplete' });
        }
      } else if (c === 0x0d) {
        i++;
      } else if (c === 0x0a) {
        textBuf += '\n';
        i++;
      } else if (c >= 32 && c < 127) {
        textBuf += bytes[i];
        i++;
      } else if (c >= 0x80) {
        let len = 1;
        if ((c & 0xe0) === 0xc0) len = 2;
        else if ((c & 0xf0) === 0xe0) len = 3;
        else if ((c & 0xf8) === 0xf0) len = 4;
        try {
          const slice = bytes.slice(i, i + len);
          const decoded = new TextDecoder().decode(Uint8Array.from(slice.split('').map((ch: string) => ch.charCodeAt(0))));
          textBuf += decoded;
        } catch {
          textBuf += `[${c.toString(16)}]`;
        }
        i += len;
      } else {
        i++;
      }
    }
    flushText();
    return segments;
  } catch {
    return [{ text: '(decode error)', category: 'text' as TagCategory }];
  }
}

/** Render segments as colored spans, optionally hiding cursor movement tags. */
function SegmentRenderer({ segments, showCursor }: { segments: Segment[]; showCursor: boolean }) {
  return (
    <>
      {segments.map((seg, i) => {
        if (!showCursor && seg.category === 'cursor') return null;
        const color = TAG_COLORS[seg.category];
        return color
          ? <span key={i} className={`${color} font-semibold`}>{seg.text} </span>
          : <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}

function buildLogText(
  shellId: string,
  data: PtyViewerData,
  replayData: PtySequenceData,
  xtermChunkCount: number,
): string {
  const baseTimestamp = replayData.chunks[0]?.timestamp;
  const statsLine = [
    `Replay: ${data.totalChunks} chunks (${formatBytes(data.totalSizeBytes)})`,
    `xterm: ${xtermChunkCount} chunks`,
    data.ptyFileSize > 0 ? `PTY file: ${formatBytes(data.ptyFileSize)}` : null,
    data.alignmentSeq >= 0 ? `Aligned at seq ${data.alignmentSeq}` : null,
  ].filter(Boolean).join('  ');

  const SEP = '─'.repeat(82);
  const lines: string[] = [
    `PTY Viewer Log — Shell: ${shellId}`,
    SEP,
    statsLine,
    SEP,
    '',
    ` ${'seq'.padStart(5)} │ ${'time'.padEnd(10)} │ ${'size'.padStart(7)} │ ${'status'.padEnd(9)} │ events / preview`,
    `${'─'.repeat(7)}┼${'─'.repeat(12)}┼${'─'.repeat(9)}┼${'─'.repeat(11)}┼${'─'.repeat(42)}`,
  ];

  const statusLabels: Record<PtyValidationStatus, string> = {
    [PtyValidationStatus.MATCH]: 'OK',
    [PtyValidationStatus.MISMATCH]: 'MISMATCH',
    [PtyValidationStatus.NO_DATA]: '—',
    [PtyValidationStatus.PRE_ALIGNMENT]: 'pre-align',
  };

  for (const row of data.rows) {
    const chunk = replayData.chunks.find(c => c.seq === row.seq);
    const status = statusLabels[row.validationStatus];
    const time = formatTimestamp(row.timestamp, baseTimestamp);
    const size = formatBytes(row.size);
    const eventStr = row.namedEvents.map(e => e.data ? `${e.name}(${e.data})` : e.name).join(' ');
    let preview = '';
    if (chunk?.data_b64) {
      const plain = decodePlainText(chunk.data_b64).replace(/\n/g, '↵').trim();
      if (plain) preview = plain.slice(0, 50);
    }
    const content = [eventStr, preview].filter(Boolean).join(' │ ');
    lines.push(` ${String(row.seq).padStart(5)} │ ${time.padEnd(10)} │ ${size.padStart(7)} │ ${status.padEnd(9)} │ ${content}`);
  }

  return lines.join('\n');
}

export function PTYViewer({ open, onClose, shell }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PtyViewerData | null>(null);
  const [replayData, setReplayData] = useState<PtySequenceData | null>(null);
  const [xtermChunkCount, setXtermChunkCount] = useState(0);
  const [selectedChunk, setSelectedChunk] = useState<PtySequenceChunkMeta | null>(null);
  const [showCursor, setShowCursor] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [tableExpanded, setTableExpanded] = useState(false);
  const [splitPct, setSplitPct] = useState(45);
  const [copied, setCopied] = useState(false);
  const draggingRef = useRef(false);

  const handleCopyLog = useCallback(() => {
    if (!data || !replayData || !shell) return;
    const text = buildLogText(shell.id, data, replayData, xtermChunkCount);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [data, replayData, shell, xtermChunkCount]);

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

  const splitContainerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const baseTimestamp = replayData?.chunks?.[0]?.timestamp;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setSelectedChunk(null); onClose(); } }}>
      <DialogContent className={`flex flex-col ${expanded ? 'max-w-[95vw] max-h-[95vh]' : 'max-w-4xl max-h-[85vh]'}`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            PTY Viewer
            {shell && <span className="text-xs text-muted-foreground font-mono">{shell.id.slice(0, 8)}</span>}
            <div className="ml-auto flex items-center gap-1">
              {data && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleCopyLog}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <ClipboardList className="h-3.5 w-3.5" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">Copy as log</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground hover:text-foreground">
                {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </div>
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

            <div ref={splitContainerRef} className="flex flex-1 min-h-0">
              {/* Chunk table */}
              <div
                className="overflow-auto min-h-0"
                style={{ width: tableExpanded || !selectedChunk ? '100%' : `${splitPct}%`, flexShrink: 0 }}
              >
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left px-2 py-1 w-16">seq</th>
                      <th className="text-left px-2 py-1 w-24">time</th>
                      <th className="text-right px-2 py-1 w-16">size</th>
                      <th className="text-center px-2 py-1 w-20">status</th>
                      <th className="text-left px-2 py-1">
                        <span className="flex items-center gap-1">
                          preview
                          {tableExpanded && selectedChunk && (
                            <button onClick={() => setTableExpanded(false)} className="hover:text-foreground" title="Show detail panel">
                              <PanelLeftClose className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      </th>
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
                            {chunk?.data_b64 ? (
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="cursor-default">
                                      <SegmentRenderer segments={decodeChunkSegments(chunk.data_b64).slice(0, 20)} showCursor={false} />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="bottom" className="max-w-lg max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs font-mono p-2">
                                    <SegmentRenderer segments={decodeChunkSegments(chunk.data_b64)} showCursor={true} />
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Draggable divider */}
              {selectedChunk && !tableExpanded && (
                <div
                  onMouseDown={handleDragStart}
                  className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 active:bg-primary transition-colors"
                />
              )}

              {/* Detail panel — shows full decoded content of selected chunk */}
              {selectedChunk && !tableExpanded && (
                <div className="flex-1 flex flex-col pl-2 min-h-0">
                  <div className="flex items-center justify-between text-xs text-muted-foreground pb-1 border-b mb-1">
                    <span>
                      Chunk <b className="text-foreground">{selectedChunk.seq}</b> — {formatBytes(selectedChunk.size)}
                    </span>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={showCursor}
                          onChange={(e) => setShowCursor(e.target.checked)}
                          className="h-3 w-3"
                        />
                        <span className="text-[10px]">cursor</span>
                      </label>
                      <button onClick={() => setTableExpanded(true)} className="hover:text-foreground" title="Expand table">
                        <PanelLeftOpen className="h-3 w-3" />
                      </button>
                      <button onClick={() => setSelectedChunk(null)} className="hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-auto min-h-0 whitespace-pre-wrap break-all text-xs font-mono bg-muted/20 rounded p-2">
                    <SegmentRenderer segments={decodeChunkSegments(selectedChunk.data_b64)} showCursor={showCursor} />
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
