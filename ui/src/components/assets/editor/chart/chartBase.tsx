import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Database, RefreshCw, StickyNote, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Trans } from '@lingui/react/macro';
import type { Chart, FSRef } from '@sdk';
import { Button } from '@src/components/ui/button';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { chartFolder, writeChartMermaid } from './chartDoc';
import { ChartHeading } from './ChartHeading';
import { chartTokens } from './chartTheme';
import {
  ChangeWholeChart,
  ChartChangeBox,
  ChartTooltip,
  ViewToggle,
  ZoomControls,
  elementQuote,
  tipStyle,
  type ChartChanges,
} from './chartControls';

/**
 * The base every native chart type is built on: one frame (header, heading, Diagram / Table, zoom,
 * hover tooltip, "Change this", the side panel) and one state hook. A chart type adds its file's
 * model and its canvas — nothing else — so every type looks and behaves like the sequence chart.
 */

export type ChartViewMode = 'chart' | 'table';

export interface ChartPick {
  id: string;
  label: string;
  at: { x: number; y: number };
}

type Point = { clientX: number; clientY: number };

/** The svg's box, the same for every chart type. A chart is laid out left to right in fixed coordinates: under an
 *  RTL page (Hebrew) SVG text-anchor "start" would mean the right end, so labels ran over their icons and punctuation
 *  moved to the wrong side -- hence `direction: 'ltr'`. */
const CHART_SVG_STYLE = { width: '100%', height: 'calc(100dvh - 290px)', minHeight: 360, direction: 'ltr' } as const;

export function ChartLoading() {
  return (
    <div data-testid="chart-loading" className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="me-2 h-4 w-4 animate-spin" />
      <Trans>Loading chart…</Trans>
    </div>
  );
}

/**
 * A chart view's state: its source file read and parsed, Diagram / Table, what the pointer is on
 * (`hot`), what is picked for a change, and the tooltip that follows the pointer without a render
 * per pixel. `parse` must never throw on `null` — that is the empty chart shown on a read error.
 */
export function useChartView<T, I>(
  fsRef: FSRef,
  chart: Chart | undefined,
  file: string,
  parse: (raw: string | null) => T,
  changes?: ChartChanges,
) {
  const sourceRef = useMemo(() => fsRef.child(file), [fsRef, file]);
  const docRef = useMemo(() => fsRef.child('CHART.md'), [fsRef]);
  const [value, setValue] = useState<T | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ChartViewMode>('chart');
  const [hot, setHot] = useState<{ target: string; info: I } | null>(null);
  const [picked, setPicked] = useState<ChartPick | null>(null);
  const tipPos = useRef({ x: 0, y: 0 });
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await sourceRef.readIfExists();
        if (!cancelled) setValue(parse(raw));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setValue(parse(null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceRef, parse]);

  const moveTip = (target: string, info: I, x: number, y: number) => {
    tipPos.current = { x, y };
    const el = tipRef.current;
    if (el) Object.assign(el.style, tipStyle(x, y));
    setHot((cur) => (cur?.target === target ? cur : { target, info }));
  };
  const showTip = (target: string, info: I, e: Point) => moveTip(target, info, e.clientX, e.clientY);
  const focusTip = (target: string, info: I, el: Element) => {
    const b = el.getBoundingClientRect();
    moveTip(target, info, b.left + b.width / 2, b.top);
  };
  const markClass = (id: string) => `${hot?.target === id ? ' hot' : ''}${picked?.id === id ? ' picked' : ''}`;
  const pick = (id: string, label: string, e: Point) => {
    if (!changes) return;
    setHot(null);
    setPicked((cur) => (cur?.id === id ? null : { id, label, at: { x: e.clientX + 12, y: e.clientY + 12 } }));
  };
  const marksOf = (id: string, label: string) => changes?.marks.get(elementQuote(id, label));
  /** The handlers of one pickable, hoverable element. */
  const element = (id: string, label: string, info: I) => ({
    'data-target': id,
    'data-label': label,
    tabIndex: 0,
    role: 'listitem',
    onPointerMove: (e: React.PointerEvent) => showTip(id, info, e),
    onFocus: (e: React.FocusEvent<Element>) => focusTip(id, info, e.currentTarget),
    onBlur: () => setHot(null),
    onClick: (e: React.MouseEvent) => pick(id, label, e),
  });
  const regenerate = useCallback(
    (mermaid: string, note: string) => writeChartMermaid(docRef, chart, mermaid, note),
    [docRef, chart],
  );

  return {
    value,
    loadError,
    setLoadError,
    view,
    setView,
    hot,
    setHot,
    picked,
    setPicked,
    tipPos,
    tipRef,
    markClass,
    pick,
    marksOf,
    element,
    regenerate,
  };
}

/** What `useChartView` hands a view — and the frame, which reads its own share of it. */
type ChartViewState = ReturnType<typeof useChartView<unknown, unknown>>;

interface ChartFrameProps {
  fsRef: FSRef;
  chart?: Chart;
  /** The view's state (`useChartView`): the frame reads the error, the view mode, the pick and the tooltip. */
  base: Pick<
    ChartViewState,
    'loadError' | 'view' | 'setView' | 'picked' | 'setPicked' | 'tipRef' | 'tipPos' | 'regenerate'
  >;
  /** The view's root test id (`chart-sequence`) and the class its styles are scoped to (`cseq`). */
  testId: string;
  scope: string;
  styles: string;
  title?: string;
  /** The line under the heading: "4 participants · 12 messages". */
  summary: ReactNode;
  /** Extra header actions (Convert to Excalidraw). */
  actions?: ReactNode;
  changes?: ChartChanges;
  /** The chart as mermaid, and the note under it — what "Update CHART.md" writes. */
  mermaid: () => string;
  note: string;
  zoom: { fit: () => void; zoomIn: () => void; zoomOut: () => void };
  /** The canvas (`ChartCanvas`). */
  children: ReactNode;
  /** The Table view, built only when it is shown. */
  table: () => ReactNode;
  /** A panel beside the canvas (`ChartSidePanel`). */
  side?: ReactNode;
  /** The hover tooltip's content; null hides it. */
  tooltip: ReactNode;
}

export function ChartFrame({
  fsRef,
  chart,
  base,
  testId,
  scope,
  styles,
  title,
  summary,
  actions,
  changes,
  mermaid,
  note,
  zoom,
  children,
  table,
  side,
  tooltip,
}: ChartFrameProps) {
  const { loadError, view, picked, setPicked: onPicked, tipRef } = base;
  const { resolvedTheme } = useTheme();
  const { folderName, dirPath } = useMemo(() => chartFolder(fsRef), [fsRef]);
  const tokens = chartTokens(resolvedTheme);
  const box = { background: 'var(--surface-1)', borderColor: 'var(--hairline)' };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={testId}>
      <AssetEditorHeader
        fileName={folderName}
        dirPath={dirPath}
        onOpenExternal={() => void fsRef.open()}
        onRevealInFinder={() => void fsRef.open({ select: true })}
        actions={
          <>
            {changes && <ChangeWholeChart changes={changes} />}
            {actions}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void base.regenerate(mermaid(), note)}
              data-testid="chart-regenerate-doc"
            >
              <Trans>Update CHART.md</Trans>
            </Button>
            {loadError && (
              <span className="text-xs text-destructive" data-testid="chart-error">
                {loadError}
              </span>
            )}
          </>
        }
      />
      <div
        className={`${scope} relative min-h-0 flex-1`}
        style={{ ...(tokens as React.CSSProperties), background: 'var(--surface-0)', color: 'var(--text-primary)' }}
      >
        <style>{styles}</style>
        <div className="absolute inset-0 overflow-auto">
          <div className="mx-auto max-w-[1640px] px-4 pb-28 pt-5">
            <header className="mb-4 flex flex-wrap items-end gap-4">
              <div className="min-w-[240px] flex-1">
                <ChartHeading title={title || chart?.name || folderName} description={chart?.description} />
                <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {summary}
                </p>
              </div>
              <ViewToggle view={view} onChange={base.setView} />
            </header>

            {view === 'chart' ? (
              <div className="flex items-start gap-4">
                <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl border" style={box}>
                  <ZoomControls onFit={zoom.fit} onIn={zoom.zoomIn} onOut={zoom.zoomOut} />
                  {children}
                </div>
                {side}
              </div>
            ) : (
              <div className="overflow-auto rounded-xl border" style={box}>
                {table()}
              </div>
            )}
          </div>
        </div>

        {picked && changes && (
          <ChartChangeBox
            label={picked.label}
            at={picked.at}
            onClose={() => onPicked(null)}
            onSubmit={(instruction, runNow) => {
              changes.request({ quote: elementQuote(picked.id, picked.label), instruction, runNow });
              onPicked(null);
            }}
          />
        )}

        {tooltip && !picked && (
          <ChartTooltip ref={tipRef} at={base.tipPos.current}>
            {tooltip}
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

interface PanZoom {
  svgRef: (el: SVGSVGElement | null) => void;
  handlers: React.SVGAttributes<SVGSVGElement>;
  viewBox: string;
  zoomed: boolean;
}

/** The canvas every chart type draws into: one pannable, zoomable svg; leaving it drops the hover. */
export function ChartCanvas({
  pz,
  svgRef,
  label,
  testId,
  onLeave,
  children,
}: {
  pz: PanZoom;
  /** A view that needs the element itself (to measure text) wraps `pz.svgRef` and passes its own. */
  svgRef?: (el: SVGSVGElement | null) => void;
  label: string;
  testId: string;
  onLeave: () => void;
  children: ReactNode;
}) {
  return (
    <svg
      ref={svgRef ?? pz.svgRef}
      {...pz.handlers}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      className="block"
      style={CHART_SVG_STYLE}
      viewBox={pz.viewBox}
      data-zoomed={pz.zoomed ? 'true' : 'false'}
      aria-label={label}
      onPointerLeave={onLeave}
      data-testid={testId}
    >
      {children}
    </svg>
  );
}

/** A chart table in the shared style: sticky header, hairline rows, a muted first column. */
export function ChartTable({ head, rows }: { head: string[]; rows: { key: string; cells: ReactNode[] }[] }) {
  return (
    <table className="w-full border-collapse text-[13px]" data-testid="chart-table">
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              className="sticky top-0 px-3.5 py-2 text-start text-xs font-semibold"
              style={{
                color: 'var(--text-secondary)',
                background: 'var(--surface-1)',
                borderBottom: '1px solid var(--hairline)',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} data-testid="chart-table-row">
            {row.cells.map((cell, k) => (
              <td
                key={k}
                className="px-3.5 py-2"
                style={{ borderBottom: '1px solid var(--hairline)', color: k === 0 ? 'var(--text-muted)' : undefined }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ChartSideRow {
  /** The element this row is about; hovering either lights the other. Absent on a chart-level row. */
  target?: string;
  /** The element's number on the canvas. */
  n?: string;
  title?: string;
  text: string;
}

/** `fact`: a stored value per numbered element. `note`: prose a reader needs beside the chart. */
export type ChartSideVariant = 'fact' | 'note';

export interface ChartSideSection {
  id: string;
  title: string;
  variant: ChartSideVariant;
  rows: ChartSideRow[];
}

/**
 * How each kind of side section looks — its icon, its colour and how strongly that colour tints the
 * card (`bg`, `border`), a lit row (`lit`) and the card's leading edge (`edge`, px). Owned here, so a
 * chart type only says which kind a section is and two kinds never read as one list.
 */
const SIDE_VARIANTS: Record<
  ChartSideVariant,
  { icon: LucideIcon; accent: string; bg: number; border: number; lit: number; edge: number }
> = {
  fact: { icon: Database, accent: 'var(--side-fact)', bg: 0, border: 0, lit: 10, edge: 1 },
  note: { icon: StickyNote, accent: 'var(--side-note)', bg: 7, border: 35, lit: 16, edge: 3 },
};

/** `pct`% of `accent` over the card surface; 0 is the plain surface. */
const tint = (accent: string, pct: number) => `color-mix(in srgb, ${accent} ${pct}%, var(--surface-1))`;

/** An element's number: filled in the section's colour, or a quiet outline. */
function NumBadge({ n, accent }: { n: string; accent?: string }) {
  return (
    <span
      className={
        accent
          ? 'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white'
          : 'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold'
      }
      style={
        accent ? { background: accent } : { borderColor: 'var(--hairline-strong)', color: 'var(--text-secondary)' }
      }
    >
      {n}
    </span>
  );
}

/** A stored value: the element's number and name, then the value as a chip. */
function FactRow({ row, accent }: { row: ChartSideRow; accent: string }) {
  return (
    <span className="flex gap-2">
      {row.n && <NumBadge n={row.n} accent={accent} />}
      <span className="min-w-0">
        {row.title && <span className="block font-semibold">{row.title}</span>}
        <span
          className="mt-1 block rounded px-1.5 py-1 font-mono text-[12px] leading-snug"
          style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
        >
          {row.text}
        </span>
      </span>
    </span>
  );
}

/** Prose first; the element it is about is a quiet caption under it. */
function NoteRow({ row }: { row: ChartSideRow }) {
  return (
    <>
      <span className="block">{row.text}</span>
      {row.title && (
        <span className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {row.n && <NumBadge n={row.n} />}
          {row.title}
        </span>
      )}
    </>
  );
}

/** The panel beside the canvas: sections of rows, linked to the canvas by hover. */
export function ChartSidePanel({
  sections,
  hot,
  onHot,
}: {
  sections: ChartSideSection[];
  hot: string | null;
  onHot: (target: string | null) => void;
}) {
  const shown = sections.filter((s) => s.rows.length);
  if (!shown.length) return null;
  return (
    <aside className="flex w-[320px] shrink-0 flex-col gap-4" data-testid="chart-side">
      {shown.map((section) => {
        const look = SIDE_VARIANTS[section.variant];
        const Icon = look.icon;
        return (
          <section
            key={section.id}
            className="rounded-xl border p-3"
            style={{
              background: tint(look.accent, look.bg),
              borderColor: look.border ? tint(look.accent, look.border) : 'var(--hairline)',
              borderInlineStartWidth: look.edge,
              borderInlineStartColor: look.edge > 1 ? look.accent : undefined,
            }}
            data-testid={`chart-side-${section.id}`}
            data-variant={section.variant}
          >
            <h2
              className="m-0 mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.08em]"
              style={{ color: look.accent }}
            >
              <Icon className="h-3.5 w-3.5" />
              {section.title}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {section.rows.map((row, i) => {
                const lit = !!row.target && row.target === hot;
                return (
                  <li
                    key={`${row.target ?? ''}:${i}`}
                    className="rounded-md border px-2 py-1.5 text-[13px]"
                    style={{
                      borderColor: lit ? look.accent : 'transparent',
                      background: lit ? tint(look.accent, look.lit) : undefined,
                    }}
                    data-testid="chart-side-row"
                    data-for={row.target}
                    data-lit={lit ? 'true' : 'false'}
                    onPointerEnter={() => row.target && onHot(row.target)}
                    onPointerLeave={() => row.target && onHot(null)}
                  >
                    {section.variant === 'note' ? <NoteRow row={row} /> : <FactRow row={row} accent={look.accent} />}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
