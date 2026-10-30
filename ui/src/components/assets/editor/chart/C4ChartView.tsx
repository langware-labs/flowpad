import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Chart, FSRef } from '@sdk';
import { FlowIcon } from '@sdk/react/FlowIcon';
import { Button } from '@src/components/ui/button';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { autoNote, writeChartMermaid } from './chartDoc';
import { ChangeWholeChart, ChartChangeBox, Marks, ZoomControls, elementQuote, type ChartChanges } from './chartControls';
import { ChartHeading } from './ChartHeading';
import { chartTokens } from './chartTheme';
import {
  C4_KIND_INFO,
  CHIP,
  c4Tag,
  c4ToMermaid,
  chipText,
  layoutC4,
  parseC4,
  type C4Card,
  type C4Chip,
  type C4Layout,
  type C4Value,
} from './c4Model';
import { useOpenChart, useOpenChartTarget } from './useOpenChart';
import { usePanZoom } from './usePanZoom';

/**
 * A `c4` chart: c4.json (chartit.c4) drawn as a C4 architecture diagram, laid out by ELK inside nested
 * boundaries. Every box is a chip like a sequence participant (dot · icon · name · format line) on a
 * shape that tells its kind; a box or arrow that calls another chart is drawn as a SUB-CHART with
 * Open ↗; link and data-type chips open what they name. Canvas zoom and pan; pick an element to ask
 * the chart's context worker for a change.
 */

const AUTO_NOTE = autoNote('c4.json');

const STYLES = `
.cc4 svg text { font-family: inherit; }
.cc4 svg { touch-action: none; }
.cc4 svg.panning { cursor: grabbing; }
.cc4 .card .body { fill: var(--surface-1); stroke: var(--hairline-strong); stroke-width: 1; }
.cc4 .card.ext .body { fill: var(--surface-2); stroke-dasharray: 5 4; }
.cc4 .card.sub .body { fill: var(--surface-2); stroke-dasharray: 4 3; }
.cc4 .card .name { fill: var(--text-primary); font-size: 13px; font-weight: 600; }
.cc4 .card .tag { fill: var(--text-muted); font-size: 11px; }
.cc4 .card .desc { fill: var(--text-secondary); font-size: 11.5px; }
.cc4 .card .subtag { fill: var(--text-muted); font-size: 9.5px; font-weight: 700; letter-spacing: .08em; }
.cc4 .pill rect { fill: var(--surface-1); stroke: var(--hairline-strong); }
.cc4 .pill text { fill: var(--text-primary); font-size: 10.5px; font-weight: 600; }
.cc4 .act { cursor: pointer; }
.cc4 .act:hover rect, .cc4 .act:focus-visible rect { stroke: var(--focus); stroke-width: 1.5; }
.cc4 .act:focus { outline: none; }
.cc4 .chip rect { fill: var(--surface-0); stroke: var(--hairline-strong); }
.cc4 .chip text { fill: var(--text-secondary); font-size: 10.5px; }
.cc4 .bnd rect { fill: none; stroke: var(--hairline-strong); stroke-width: 1.2; stroke-dasharray: 7 5; }
.cc4 .bnd .blabel { fill: var(--text-primary); font-size: 12px; font-weight: 600; }
.cc4 .bnd .btag { fill: var(--text-muted); font-size: 11px; }
.cc4 .rel .line { fill: none; stroke: var(--text-muted); stroke-opacity: .7; stroke-width: 1.5; }
.cc4 .rel.async .line { stroke-dasharray: 6 5; }
.cc4 .rel .hit { fill: none; stroke: transparent; stroke-width: 18; pointer-events: stroke; }
.cc4 .rel .plate { fill: var(--surface-1); }
.cc4 .rel.sub .plate { fill: var(--surface-2); stroke: var(--hairline-strong); stroke-dasharray: 4 3; }
.cc4 .rel .label { fill: var(--text-primary); font-size: 11.5px; font-weight: 500; text-anchor: middle; }
.cc4 .rel .tech { fill: var(--text-muted); font-size: 10.5px; text-anchor: middle; }
.cc4 .num { fill: #fff; font-size: 10px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.cc4 .rel.hot .line { stroke: var(--focus); stroke-opacity: 1; stroke-width: 2.25; }
.cc4 svg.focusing .card:not(.hot):not(.near), .cc4 svg.focusing .rel:not(.hot) { opacity: .3; transition: opacity .12s; }
.cc4 [data-target] { cursor: pointer; }
.cc4 [data-target]:focus { outline: none; }
.cc4 .card:focus-visible .body, .cc4 .card.picked .body, .cc4 .bnd.picked rect, .cc4 .rel.picked .plate { stroke: var(--focus); stroke-width: 2; }
.cc4 .rel.picked .line { stroke: var(--focus); stroke-opacity: 1; }
@media (prefers-reduced-motion: reduce) { .cc4 svg.focusing .card, .cc4 svg.focusing .rel { transition: none; } }
`;

/** Characters → px, before layout can be measured (jsdom, first paint). */
const textW = (text: string, px = 6.4) => text.length * px;

function CardShape({ c }: { c: C4Card }) {
  const { x, y, w, h, top, el, slot } = c;
  const color = `var(${slot})`;
  if (el.kind === 'person' || el.kind === 'role') {
    return (
      <>
        <rect className="body" x={x} y={top} width={w} height={h - (top - y)} rx={14} />
        {el.kind === 'person' && <circle cx={x + w / 2} cy={top} r={16} fill={color} stroke="var(--surface-1)" strokeWidth={3} />}
      </>
    );
  }
  if (el.kind === 'database' || el.kind === 'storage') {
    const ry = 8;
    return (
      <>
        <path className="body" d={`M${x},${y + ry} a${w / 2},${ry} 0 0,1 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0,1 ${-w},0 Z`} />
        <ellipse cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} fill="none" stroke={color} strokeWidth={2.5} />
      </>
    );
  }
  if (el.kind === 'function' || el.kind === 'action') {
    // A notched card: a step that runs, not a thing that lives.
    const n = 12;
    return (
      <>
        <path className="body" d={`M${x + n},${y} H${x + w} V${y + h} H${x + n} L${x},${y + h / 2} Z`} />
        <rect x={x + n + 6} y={y} width={w - n - 16} height={3.5} rx={1.75} fill={color} />
      </>
    );
  }
  const rx = el.kind === 'queue' ? 22 : el.kind === 'code' ? 3 : el.kind === 'api' ? 16 : 10;
  return (
    <>
      <rect className="body" x={x} y={y} width={w} height={h} rx={rx} />
      <rect x={x + rx} y={y} width={w - 2 * rx} height={3.5} rx={1.75} fill={color} />
    </>
  );
}

interface C4ChartViewProps {
  fsRef: FSRef;
  chart?: Chart;
  projectId?: string;
  /** Pick an element → "Change this" → the chart's Changes tab and context worker. */
  changes?: ChartChanges;
}

export function C4ChartView({ fsRef, chart, projectId, changes }: C4ChartViewProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const sourceRef = useMemo(() => fsRef.child('c4.json'), [fsRef]);
  const docRef = useMemo(() => fsRef.child('CHART.md'), [fsRef]);
  const [value, setValue] = useState<C4Value | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hot, setHot] = useState<{ target: string; title: string; sub: string; note?: string } | null>(null);
  const [picked, setPicked] = useState<{ id: string; label: string; at: { x: number; y: number } } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openRef = useOpenChart(fsRef, projectId);
  const { openLink, openSchema } = useOpenChartTarget(fsRef, projectId);

  const { folderName, dirPath } = useMemo(() => {
    const parts = (fsRef.path || '').split('/').filter(Boolean);
    const tail = parts.pop() || 'chart';
    return { folderName: tail, dirPath: parts.length ? '/' + parts.join('/') : '' };
  }, [fsRef]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await sourceRef.readIfExists();
        if (!cancelled) setValue(parseC4(raw));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setValue(parseC4(null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceRef]);

  const [layout, setLayout] = useState<C4Layout | null>(null);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    layoutC4(value).then(
      (next) => !cancelled && setLayout(next),
      (err: unknown) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [value]);
  const mermaid = useMemo(() => (value ? c4ToMermaid(value) : ''), [value]);
  const pz = usePanZoom(layout?.width ?? 1, layout?.height ?? 1);

  const nameOf = useCallback((id: string) => layout?.cardOf.get(id)?.el.label ?? id, [layout]);

  const regenerateDoc = useCallback(async () => {
    if (mermaid) await writeChartMermaid(docRef, chart, mermaid, AUTO_NOTE);
  }, [docRef, chart, mermaid]);

  if (!value || !layout) {
    return (
      <div data-testid="chart-loading" className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="me-2 h-4 w-4 animate-spin" />
        <Trans>Loading chart…</Trans>
      </div>
    );
  }

  const tokens = chartTokens(resolvedTheme);
  const { cards, boxes, edges } = layout;
  const hotEdge = hot ? layout.edgeOf.get(hot.target) : undefined;
  const near = new Set(hotEdge ? [hotEdge.r.from, hotEdge.r.to] : []);
  const hotCardLinks = new Set(
    hot && layout.cardOf.has(hot.target)
      ? edges.filter((e) => e.r.from === hot.target || e.r.to === hot.target).map((e) => e.r.id)
      : [],
  );
  const markClass = (id: string) =>
    `${hot?.target === id || hotCardLinks.has(id) ? ' hot' : ''}${near.has(id) ? ' near' : ''}${picked?.id === id ? ' picked' : ''}`;
  const place = (x: number, y: number) => {
    const el = tipRef.current;
    if (el) Object.assign(el.style, { left: `${Math.min(window.innerWidth - 328, x + 14)}px`, top: `${Math.max(8, y - 72)}px` });
  };
  const marksOf = (id: string, label: string) => changes?.marks.get(elementQuote(id, label));
  const pick = (id: string, label: string, e: { clientX: number; clientY: number }) => {
    if (!changes) return;
    setHot(null);
    setPicked((cur) => (cur?.id === id ? null : { id, label, at: { x: e.clientX + 12, y: e.clientY + 12 } }));
  };
  const handlers = (id: string, label: string, title: string, sub: string, note?: string) => ({
    'data-target': id,
    tabIndex: 0,
    role: 'listitem',
    onPointerMove: (e: React.PointerEvent) => {
      if (picked) return;
      setHot((cur) => (cur?.target === id ? cur : { target: id, title, sub, note }));
      place(e.clientX, e.clientY);
    },
    onFocus: (e: React.FocusEvent<SVGGElement>) => {
      const b = e.currentTarget.getBoundingClientRect();
      setHot({ target: id, title, sub, note });
      place(b.left + b.width / 2, b.top);
    },
    onBlur: () => setHot(null),
    onClick: (e: React.MouseEvent) => pick(id, label, e),
    onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const b = e.currentTarget.getBoundingClientRect();
        pick(id, label, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
      }
    },
  });
  /** A clickable pill or chip inside a picked-able group: it acts, it never picks. */
  const act = (fn: () => void) => ({
    className: 'act',
    tabIndex: 0,
    role: 'link',
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      fn();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    },
  });
  const openChip = (chip: C4Chip) => ('schema' in chip.open ? void openSchema(chip.open.schema) : openLink(chip.open.link));
  // Render functions, not components: a component defined in render remounts its DOM every render.
  const chipNode = (chip: C4Chip, x: number, y: number, key: string | number) => (
    <g key={key} {...act(() => openChip(chip))} data-testid={'schema' in chip.open ? 'chart-c4-type' : 'chart-c4-link'}>
      <g className="chip">
        <rect x={x} y={y} width={chip.w} height={20} rx={10} />
        <foreignObject x={x + 6} y={y + 3} width={14} height={14}>
          <FlowIcon icon={chip.icon} size={14} />
        </foreignObject>
        <text x={x + 24} y={y + 14}>
          {chipText(chip.label)}
        </text>
      </g>
    </g>
  );
  const openPill = (x: number, y: number, target: string, label: string) => (
    <g {...act(() => void openRef(target))} aria-label={t`Open ${label}`} data-testid="chart-c4-open">
      <g className="pill">
        <rect x={x} y={y} width={62} height={20} rx={10} />
        <text x={x + 31} y={y + 14} textAnchor="middle">
          {t`Open ↗`}
        </text>
      </g>
    </g>
  );
  const kindsShown = [...new Map(cards.map((c) => [`${c.el.kind}${c.el.external ? '-ext' : ''}`, c])).values()];
  const hasAsync = edges.some((e) => e.r.style === 'async');
  const requestChange = (quote: string, instruction: string, runNow: boolean) => {
    changes?.request({ quote, instruction, runNow });
    setPicked(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chart-c4">
      <AssetEditorHeader
        fileName={folderName}
        dirPath={dirPath}
        onOpenExternal={() => void fsRef.open()}
        onRevealInFinder={() => void fsRef.open({ select: true })}
        actions={
          <>
            {changes && <ChangeWholeChart changes={changes} />}
            <Button size="sm" variant="outline" onClick={() => void regenerateDoc()} data-testid="chart-regenerate-doc">
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
        className="cc4 relative min-h-0 flex-1"
        style={{ ...(tokens as React.CSSProperties), background: 'var(--surface-0)', color: 'var(--text-primary)' }}
      >
        <style>{STYLES}</style>
        <div className="absolute inset-0 overflow-auto">
          <div className="mx-auto max-w-[1640px] px-4 pb-6 pt-5">
            <header className="mb-4 flex flex-wrap items-end gap-4">
              <div className="min-w-[240px] flex-1">
                <ChartHeading title={value.title || chart?.name || folderName} description={chart?.description} />
                <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }} data-testid="chart-c4-summary">
                  <span
                    className="me-2 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ background: 'var(--surface-2)' }}
                    data-testid="chart-c4-level"
                  >
                    {value.level}
                  </span>
                  <Trans>
                    {value.elements.length} elements · {value.relations.length} relations
                  </Trans>
                </p>
              </div>
              <div className="inline-flex rounded-lg p-[3px]" style={{ background: 'var(--surface-2)' }} role="group" aria-label={t`View`}>
                {(['chart', 'table'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                    data-testid={`chart-view-${v}`}
                    className="rounded-md px-3 py-1 text-[13px] font-medium"
                    style={
                      view === v
                        ? { background: 'var(--surface-1)', color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,.08)' }
                        : { color: 'var(--text-secondary)' }
                    }
                  >
                    {v === 'chart' ? <Trans>Diagram</Trans> : <Trans>Table</Trans>}
                  </button>
                ))}
              </div>
            </header>

            {view === 'chart' ? (
              <>
                <div className="relative overflow-hidden rounded-xl border" style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
                  <ZoomControls onFit={pz.fit} onIn={pz.zoomIn} onOut={pz.zoomOut} />
                  <svg
                    ref={pz.svgRef}
                    xmlns="http://www.w3.org/2000/svg"
                    role="img"
                    className={`block${hot ? ' focusing' : ''}${pz.panning ? ' panning' : ''}`}
                    style={{ width: '100%', height: 'calc(100vh - 290px)', minHeight: 360 }}
                    viewBox={pz.viewBox}
                    data-zoomed={pz.zoomed ? 'true' : 'false'}
                    aria-label={t`${value.title || t`C4 chart`}: ${value.elements.length} elements, ${value.relations.length} relations`}
                    onPointerLeave={() => setHot(null)}
                    data-testid="chart-c4-svg"
                    {...pz.handlers}
                  >
                    <defs>
                      <marker id="c4-ah" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={10} markerHeight={10} orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                        <path d="M1,1 L9,5 L1,9 Z" fill="var(--text-muted)" />
                      </marker>
                      <marker id="c4-ah-hot" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={11} markerHeight={11} orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                        <path d="M1,1 L9,5 L1,9 Z" fill="var(--focus)" />
                      </marker>
                    </defs>
                    <g>
                      {boxes.map(({ b, x, y, w, h }) => {
                        const tag = [b.kind, b.tech].filter(Boolean).join(' · ');
                        return (
                          <g
                            key={b.id}
                            className={`bnd${markClass(b.id)}`}
                            aria-label={`Boundary ${b.label}`}
                            data-testid="chart-c4-boundary"
                            {...handlers(b.id, b.label, b.label, tag, b.note)}
                          >
                            <rect x={x} y={y} width={w} height={h} rx={12} />
                            <text className="blabel" x={x + 14} y={y + 20}>
                              {b.label}
                            </text>
                            {tag && (
                              <text className="btag" x={x + 20 + textW(b.label, 7)} y={y + 20}>
                                [{tag}]
                              </text>
                            )}
                            <Marks ns={marksOf(b.id, b.label)} x={x + w - 14} y={y + 16} />
                          </g>
                        );
                      })}
                    </g>
                    <g>
                      {edges.map((e) => {
                        const isHot = hot?.target === e.r.id || hotCardLinks.has(e.r.id) || picked?.id === e.r.id;
                        const lines = [e.r.label, e.r.tech ? `[${e.r.tech}]` : ''].filter(Boolean);
                        const { pw, ph } = e;
                        const px = e.lx - pw / 2;
                        const py = e.ly - ph / 2;
                        let cy = py + 6 + lines.length * 15 + 2;
                        const dataChip: C4Chip | null = e.r.data
                          ? { label: `⟨${e.r.data}⟩`, icon: 'lucide.braces', open: { schema: e.r.data }, x: 0, y: 0, w: Math.min(pw - 12, 30 + (e.r.data.length + 2) * 6.2) }
                          : null;
                        return (
                          <g
                            key={e.r.id}
                            className={`rel${e.r.style === 'async' ? ' async' : ''}${e.r.ref ? ' sub' : ''}${markClass(e.r.id)}`}
                            aria-label={`${e.n ? `${e.n}. ` : ''}${e.r.label}, from ${nameOf(e.r.from)} to ${nameOf(e.r.to)}`}
                            data-testid="chart-c4-relation"
                            {...handlers(e.r.id, e.r.label, `${e.n ? `${e.n}. ` : ''}${e.r.label}`, `${nameOf(e.r.from)} → ${nameOf(e.r.to)}`, e.r.note)}
                          >
                            <path d={e.d} className="hit" />
                            <path d={e.d} className="line" markerEnd={`url(#${isHot ? 'c4-ah-hot' : 'c4-ah'})`} />
                            <rect className="plate" x={px} y={py} width={pw} height={ph} rx={6} />
                            <text className="label" x={e.lx} y={py + 15}>
                              {lines[0]}
                            </text>
                            {lines[1] && (
                              <text className="tech" x={e.lx} y={py + 30}>
                                {lines[1]}
                              </text>
                            )}
                            {dataChip && (() => {
                              const node = chipNode(dataChip, e.lx - dataChip.w / 2, cy, 'data');
                              cy += 24;
                              return node;
                            })()}
                            {e.r.ref && openPill(e.lx - 31, cy, e.r.ref, e.r.label)}
                            {e.n && (
                              <>
                                <circle cx={px - 4} cy={py + 2} r={9} fill="var(--s2)" stroke="var(--surface-1)" strokeWidth={2} />
                                <text className="num" x={px - 4} y={py + 2.5}>
                                  {e.n}
                                </text>
                              </>
                            )}
                            <Marks ns={marksOf(e.r.id, e.r.label)} x={px + pw + 4} y={py + 2} />
                          </g>
                        );
                      })}
                    </g>
                    <g>
                      {cards.map((c) => {
                        const { el, x, w, top } = c;
                        const head = top + 14 + (el.kind === 'person' ? 6 : 0);
                        let ty = head + 13;
                        const foot = c.y + c.h - 12;
                        return (
                          <g
                            key={el.id}
                            className={`card${el.external ? ' ext' : ''}${el.ref ? ' sub' : ''}${markClass(el.id)}`}
                            aria-label={`${c.tag} ${el.label}`}
                            data-testid="chart-c4-element"
                            data-kind={el.kind}
                            {...handlers(el.id, el.label, el.label, c.tag, [el.description, el.note].filter(Boolean).join(' — '))}
                          >
                            <CardShape c={c} />
                            <circle cx={x + CHIP.DOT_X} cy={head + 8} r={5} fill={`var(${c.slot})`} />
                            <foreignObject x={x + CHIP.ICON_X} y={head - 2} width={CHIP.ICON} height={CHIP.ICON}>
                              <FlowIcon icon={c.icon} size={CHIP.ICON} title={C4_KIND_INFO[el.kind].name} />
                            </foreignObject>
                            {el.ref && (
                              <text className="subtag" x={x + w - 12} y={head + 1} textAnchor="end">
                                SUB-CHART
                              </text>
                            )}
                            {c.name.map((line) => {
                              const node = (
                                <text key={`n${line}`} className="name" x={x + CHIP.TEXT_X} y={ty}>
                                  {line}
                                </text>
                              );
                              ty += 17;
                              return node;
                            })}
                            <text className="tag" x={x + CHIP.TEXT_X} y={ty - 2}>
                              {c.tag}
                            </text>
                            {c.desc.map((line, i) => (
                              <text key={`d${i}`} className="desc" x={x + 14} y={ty + 19 + i * 15}>
                                {line}
                              </text>
                            ))}
                            {c.chips.map((chip, i) => chipNode(chip, x + chip.x, c.chipsY + chip.y, i))}
                            {el.status && el.status !== 'current' && (
                              <g className="pill" data-testid="chart-c4-status">
                                <rect
                                  x={x + 12}
                                  y={foot - 13}
                                  width={textW(el.status, 6.4) + 16}
                                  height={20}
                                  rx={10}
                                  style={el.status === 'migrating' ? { fill: 'var(--s2)', stroke: 'var(--s2)' } : { strokeDasharray: '4 3' }}
                                />
                                <text x={x + 20} y={foot + 1} style={el.status === 'migrating' ? { fill: '#fff' } : undefined}>
                                  {el.status}
                                </text>
                              </g>
                            )}
                            {el.ref && openPill(x + w - 74, foot - 13, el.ref, el.label)}
                            <Marks ns={marksOf(el.id, el.label)} x={x + 2} y={c.y + 2} />
                          </g>
                        );
                      })}
                    </g>
                  </svg>
                </div>
                <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }} data-testid="chart-c4-legend">
                  {kindsShown.map((c) => (
                    <li key={`${c.el.kind}${c.el.external}`} className="flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: `var(${c.slot})` }} />
                      <FlowIcon icon={C4_KIND_INFO[c.el.kind].icon} size={13} />
                      {c4Tag({ ...c.el, tech: undefined })}
                    </li>
                  ))}
                  <li className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-5" style={{ background: 'var(--text-muted)' }} />
                    <Trans>call</Trans>
                  </li>
                  {hasAsync && (
                    <li className="flex items-center gap-1.5">
                      <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: 'var(--text-muted)' }} />
                      <Trans>async</Trans>
                    </li>
                  )}
                  <li style={{ color: 'var(--text-muted)' }}>
                    <Trans>Scroll to zoom · drag to pan{changes ? ' · click an element to change it' : ''}</Trans>
                  </li>
                </ul>
              </>
            ) : (
              <div className="space-y-4" data-testid="chart-table">
                {[
                  {
                    head: [t`Element`, t`Kind`, t`Boundary`, t`Description`],
                    rows: value.elements.map((e) => ({
                      key: e.id,
                      cells: [e.label, c4Tag(e), value.boundaries.find((b) => b.id === e.boundary)?.label ?? '', e.description ?? ''],
                    })),
                  },
                  {
                    head: [t`#`, t`From`, t`To`, t`Relation`],
                    rows: value.relations.map((r, i) => ({
                      key: r.id ?? String(i),
                      cells: [
                        String(r.order ?? i + 1),
                        nameOf(r.from),
                        nameOf(r.to),
                        `${r.label}${r.tech ? ` [${r.tech}]` : ''}${r.data ? ` ⟨${r.data}⟩` : ''}${r.style === 'async' ? ' (async)' : ''}`,
                      ],
                    })),
                  },
                ].map((table, ti) => (
                  <div key={ti} className="overflow-auto rounded-xl border" style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr>
                          {table.head.map((h) => (
                            <th
                              key={h}
                              className="sticky top-0 px-3.5 py-2 text-start text-xs font-semibold"
                              style={{ color: 'var(--text-secondary)', background: 'var(--surface-1)', borderBottom: '1px solid var(--hairline)' }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.map((row) => (
                          <tr key={row.key} data-testid="chart-table-row">
                            {row.cells.map((cell, k) => (
                              <td key={k} className="px-3.5 py-2" style={{ borderBottom: '1px solid var(--hairline)' }}>
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {hot && !picked && (
          <div
            ref={tipRef}
            role="tooltip"
            data-testid="chart-tooltip"
            className="pointer-events-none fixed z-10 max-w-[320px] rounded-lg border px-2.5 py-2 text-xs shadow-lg"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline-strong)' }}
          >
            <span className="block text-[13px] font-semibold">{hot.title}</span>
            {hot.sub && (
              <span className="mt-0.5 block" style={{ color: 'var(--text-secondary)' }}>
                {hot.sub}
              </span>
            )}
            {hot.note && (
              <span className="mt-1 block" style={{ color: 'var(--text-muted)' }}>
                {hot.note}
              </span>
            )}
          </div>
        )}

        {picked && changes && (
          <ChartChangeBox
            label={picked.label}
            at={picked.at}
            onClose={() => setPicked(null)}
            onSubmit={(instruction, runNow) =>
              requestChange(elementQuote(picked.id, picked.label), instruction, runNow)
            }
          />
        )}
      </div>
    </div>
  );
}

export default C4ChartView;
