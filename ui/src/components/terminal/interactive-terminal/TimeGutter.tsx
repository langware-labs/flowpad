import { t } from '@lingui/core/macro';
import { Fragment } from 'react';
import type { RowSyncData } from './use-time-gutter';
import type { TraceFilters } from './InteractiveTerminal';
import type { PtySyncSession } from '@sdk/pty-sync/PtySyncSession.js';
import type { PtyLineRange, PtySegment } from '@sdk/pty-sync/PtySegment.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';

// Approximate width (px) each field contributes at 9px monospace + 8px total h-padding
export const FIELD_WIDTHS: Record<'time' | 'index' | 'line' | 'absLine' | 'debugTime' | 'refTime', number> = {
  time: 92, // "14:32:07 (99m)"
  index: 38, // "#99999"
  line: 30, // "L9999"
  absLine: 38, // "@99999"
  debugTime: 44, // "99.9s"
  refTime: 100, // "HH:MM:SS→HH:MM:SS"
};
export const FIELD_GAP = 6; // px gap rendered between fields as a space character

export function calcTimeGutterWidth(filters: TraceFilters): number {
  const active = (['time', 'index', 'line', 'absLine', 'debugTime', 'refTime'] as const).filter((k) => filters[k]);
  if (active.length === 0) return 0;
  const sum = active.reduce((acc, k) => acc + FIELD_WIDTHS[k], 0);
  return sum + (active.length - 1) * FIELD_GAP;
}

function formatISOTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatISOFull(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatTimeAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function SegmentBorderTooltipContent({
  isStart,
  isEnd,
  segment,
}: {
  isStart: boolean;
  isEnd: boolean;
  segment: PtySegment;
}) {
  const durMs = segment.endTime - segment.startTime;
  const endRow = segment.baseAbsRow + segment.rows - 1;
  const lines: { label: string; value: string; sub?: string }[] = [
    {
      label: t`Boundary`,
      value: isStart && isEnd ? 'Start & End' : isStart ? 'Segment Start' : 'Segment End',
    },
    {
      label: t`Start time`,
      value: formatTimestamp(segment.startTime),
      sub: new Date(segment.startTime).toLocaleString(),
    },
    {
      label: t`End time`,
      value: `${formatTimestamp(segment.endTime)}${segment.finalized ? '' : ' (live)'}`,
      sub: new Date(segment.endTime).toLocaleString(),
    },
    { label: t`Duration`, value: formatDurationMs(durMs) },
    { label: t`Row range`, value: `@${segment.baseAbsRow} → @${endRow}`, sub: `${segment.rows} rows` },
  ];
  if (segment.startAnchor) {
    lines.push({
      label: t`Start anchor`,
      value: segment.startAnchor.text.slice(0, 40),
      sub: formatISOFull(segment.startAnchor.time),
    });
  }
  if (segment.endAnchor) {
    lines.push({
      label: t`End anchor`,
      value: segment.endAnchor.text.slice(0, 40),
      sub: formatISOFull(segment.endAnchor.time),
    });
  }
  return (
    <div className="grid gap-x-3 gap-y-1.5 p-3" style={{ gridTemplateColumns: 'auto 1fr', maxWidth: 320 }}>
      {lines.map(({ label, value, sub }) => (
        <Fragment key={label}>
          <span className="self-start pt-px text-end font-mono text-sky-400/80" style={{ fontSize: 12 }}>
            {label}
          </span>
          <span className="flex flex-col font-mono" style={{ fontSize: 12 }}>
            <span className="font-bold text-white">{value}</span>
            {sub && (
              <span className="font-normal text-white/55" style={{ fontSize: 11 }}>
                {sub}
              </span>
            )}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

interface RowTooltipProps {
  row: RowSyncData;
  absRow: number;
  filters: TraceFilters;
  ptySyncSession: PtySyncSession;
  ref_: PtyLineRange | undefined;
}

function RowTooltipContent({ row, absRow, filters, ptySyncSession, ref_ }: RowTooltipProps) {
  const lines: { label: string; value: string; sub?: string }[] = [];

  if (filters.time) {
    if (row.timestamp !== null) {
      const d = new Date(row.timestamp);
      lines.push({
        label: t`PTY time`,
        value: `${formatTimestamp(row.timestamp)} (${formatTimeAgo(row.timestamp)})`,
        sub: d.toLocaleString(),
      });
    } else {
      lines.push({ label: t`PTY time`, value: 'no chunk timestamp' });
    }
  }

  if (filters.index) {
    lines.push({
      label: t`Seq #`,
      value: row.ownerSeq !== null ? `#${row.ownerSeq}` : 'none',
    });
  }

  if (filters.line) {
    lines.push({
      label: t`Logical line`,
      value: row.logicalLine !== null ? `L${row.logicalLine}` : 'none',
    });
  }

  if (filters.absLine) {
    lines.push({ label: t`Abs row`, value: `@${absRow}` });
  }

  if (filters.debugTime) {
    const range = ptySyncSession.getRowTimeRange(absRow);
    if (range) {
      const durMs = range.endTime - range.startTime;
      lines.push({
        label: t`Segment dur`,
        value: formatDurationMs(durMs),
        sub: `${(durMs / 1000).toFixed(3)}s raw`,
      });
    } else {
      lines.push({ label: t`Segment dur`, value: 'no segment' });
    }
  }

  if (filters.refTime) {
    if (ref_) {
      const durMs = new Date(ref_.stopTime).getTime() - new Date(ref_.startTime).getTime();
      lines.push({
        label: t`Anchor range`,
        value: `${formatISOTime(ref_.startTime)} → ${formatISOTime(ref_.stopTime)}`,
        sub: `duration: ${formatDurationMs(durMs)} · ${formatISOFull(ref_.startTime)}`,
      });
    } else {
      lines.push({ label: t`Anchor range`, value: 'no anchor for this row' });
    }
  }

  return (
    <div className="grid gap-x-3 gap-y-1.5 p-3" style={{ gridTemplateColumns: 'auto 1fr' }}>
      {lines.map(({ label, value, sub }) => (
        <Fragment key={label}>
          <span className="self-start pt-px text-end font-mono text-white/50" style={{ fontSize: 13 }}>
            {label}
          </span>
          <span className="flex flex-col font-mono" style={{ fontSize: 13 }}>
            <span className="font-bold text-white">{value}</span>
            {sub && (
              <span className="font-normal text-white/55" style={{ fontSize: 11 }}>
                {sub}
              </span>
            )}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

interface TimeGutterProps {
  rows: RowSyncData[];
  cellHeight: number;
  filters: TraceFilters;
  ptySyncSession: PtySyncSession;
  viewportY: number;
  refLines?: PtyLineRange[];
}

export function TimeGutter({ rows, cellHeight, filters, ptySyncSession, viewportY, refLines = [] }: TimeGutterProps) {
  if (cellHeight <= 0) return null;

  const width = calcTimeGutterWidth(filters);

  // Build a Map for O(1) refLine lookup per row
  const refLineMap = new Map<number, PtyLineRange>();
  for (const rl of refLines) {
    refLineMap.set(rl.absRow, rl);
  }

  const { starts: segmentStarts, ends: segmentEnds } = ptySyncSession.getSegmentBorderRows();

  return (
    <TooltipProvider delayDuration={500}>
      <div
        data-testid="time-gutter"
        style={{ width, minWidth: width }}
        className="relative shrink-0 select-none border-e border-border/50 bg-muted/30"
      >
        {rows.map((row, i) => {
          const absRow = viewportY + i;
          const ref_ = refLineMap.get(absRow);
          const isSegmentStart = segmentStarts.has(absRow);
          const isSegmentEnd = segmentEnds.has(absRow);

          // Build per-field cells with fixed widths matching FIELD_WIDTHS
          const fieldCells: { key: string; width: number; text: string }[] = [];

          if (filters.time) {
            fieldCells.push({
              key: 'time',
              width: FIELD_WIDTHS.time,
              text:
                row.timestamp !== null
                  ? `${formatTimestamp(row.timestamp)} (${formatTimeAgo(row.timestamp)})`
                  : '--:--:--',
            });
          }
          if (filters.index) {
            fieldCells.push({
              key: 'index',
              width: FIELD_WIDTHS.index,
              text: row.ownerSeq !== null ? `#${row.ownerSeq}` : '-',
            });
          }
          if (filters.line) {
            fieldCells.push({
              key: 'line',
              width: FIELD_WIDTHS.line,
              text: row.logicalLine !== null ? `L${row.logicalLine}` : '-',
            });
          }
          if (filters.absLine) {
            fieldCells.push({ key: 'absLine', width: FIELD_WIDTHS.absLine, text: `@${absRow}` });
          }
          if (filters.debugTime) {
            const range = ptySyncSession.getRowTimeRange(absRow);
            fieldCells.push({
              key: 'debugTime',
              width: FIELD_WIDTHS.debugTime,
              text: range ? `${((range.endTime - range.startTime) / 1000).toFixed(1)}s` : '-s',
            });
          }
          if (filters.refTime) {
            fieldCells.push({
              key: 'refTime',
              width: FIELD_WIDTHS.refTime,
              text: ref_ ? `${formatISOTime(ref_.startTime)}→${formatISOTime(ref_.stopTime)}` : '--:--:--→--:--:--',
            });
          }

          const segmentBorderInfo =
            isSegmentStart || isSegmentEnd ? ptySyncSession.getSegmentForBorderRow(absRow) : null;

          return (
            <div key={i} className="relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    style={{ height: cellHeight, lineHeight: `${cellHeight}px`, fontSize: 9, gap: FIELD_GAP }}
                    className="flex items-center overflow-hidden px-1 font-mono text-black dark:text-white"
                  >
                    {fieldCells.map(({ key, width, text }) => (
                      <span key={key} style={{ width, minWidth: width }} className="overflow-hidden text-nowrap">
                        {text}
                      </span>
                    ))}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right" className="border-0 bg-neutral-900 p-0 shadow-xl" sideOffset={4}>
                  <RowTooltipContent
                    row={row}
                    absRow={absRow}
                    filters={filters}
                    ptySyncSession={ptySyncSession}
                    ref_={ref_}
                  />
                </TooltipContent>
              </Tooltip>
              {/* Segment start border — thick, hoverable */}
              {isSegmentStart && segmentBorderInfo && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="absolute inset-x-0 top-0 h-[3px] cursor-pointer bg-sky-500/70 hover:bg-sky-500 dark:bg-sky-400/70 dark:hover:bg-sky-400" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="border-0 bg-neutral-900 p-0 shadow-xl" sideOffset={4}>
                    <SegmentBorderTooltipContent
                      isStart={segmentBorderInfo.isStart}
                      isEnd={segmentBorderInfo.isEnd}
                      segment={segmentBorderInfo.segment}
                    />
                  </TooltipContent>
                </Tooltip>
              )}
              {/* Segment end border — thick, hoverable */}
              {isSegmentEnd && segmentBorderInfo && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="absolute inset-x-0 bottom-0 h-[3px] cursor-pointer bg-sky-500/70 hover:bg-sky-500 dark:bg-sky-400/70 dark:hover:bg-sky-400" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="border-0 bg-neutral-900 p-0 shadow-xl" sideOffset={4}>
                    <SegmentBorderTooltipContent
                      isStart={segmentBorderInfo.isStart}
                      isEnd={segmentBorderInfo.isEnd}
                      segment={segmentBorderInfo.segment}
                    />
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
