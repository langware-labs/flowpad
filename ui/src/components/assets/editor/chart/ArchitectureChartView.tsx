import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Chart, FSRef } from '@sdk';
import { FlowIcon } from '@sdk/react/FlowIcon';
import { Button } from '@src/components/ui/button';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { autoNote, chartFolder, writeChartMermaid } from './chartDoc';
import {
  ChangeWholeChart,
  ChartChangeBox,
  chartAct,
  ChartTooltip,
  Marks,
  ViewToggle,
  ZoomControls,
  elementQuote,
  tipStyle,
  type ChartChanges,
} from './chartControls';
import { ChartHeading } from './ChartHeading';
import { ARCH_ROLE_COLORS, chartTokens } from './chartTheme';
import {
  ARCH_ROLE_ICON,
  architectureToMermaid,
  layoutArchitecture,
  namesOf,
  parseArchitecture,
  partPlaces,
  type ArchValue,
} from './architectureModel';
import { useOpenChart } from './useOpenChart';
import { usePanZoom } from './usePanZoom';

/**
 * An `architecture` chart: architecture.json (chartit.architecture) drawn the way cloud architecture
 * diagrams are — solid groups for where things run, dashed tiers inside them, a role icon per part
 * (client, service, db, files, worker, external), labelled links, numbered steps. A step badge opens
 * the steps list; a part with a `ref` opens that chart. Pick a part to ask the context worker for a change.
 */

const AUTO_NOTE = autoNote('architecture.json');
const GROUP_STROKE = '#f59e0b';

const STYLES = `
.carch svg text { font-family: inherit; }
.carch svg { touch-action: none; }
.carch .grp > rect { fill: none; stroke: ${GROUP_STROKE}; stroke-width: 1.6; }
.carch .grp .glabel { fill: ${GROUP_STROKE}; font-size: 13px; font-weight: 700; text-anchor: middle; }
.carch .grp .gsub { fill: var(--text-muted); font-size: 11px; text-anchor: middle; }
.carch .tier > rect { fill: none; stroke: var(--hairline-strong); stroke-width: 1.2; stroke-dasharray: 6 4; }
.carch .tier .tlabel { fill: var(--text-secondary); font-size: 11.5px; }
.carch .part .name { fill: var(--text-primary); font-size: 12px; font-weight: 600; text-anchor: middle; }
.carch .part .sub { fill: var(--text-muted); font-size: 10.5px; text-anchor: middle; }
.carch .part .hit { fill: transparent; }
.carch .link .line { fill: none; stroke: var(--text-muted); stroke-width: 1.5; }
.carch .link.dashed .line { stroke-dasharray: 6 5; }
.carch .link .hit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; }
.carch .link .plate { fill: var(--surface-1); }
.carch .link .label { fill: var(--text-secondary); font-size: 10.5px; text-anchor: middle; }
.carch .badge circle { fill: var(--surface-0); stroke: var(--text-primary); stroke-width: 1.3; }
.carch .badge text { fill: var(--text-primary); font-size: 11px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.carch .badge.on circle { fill: var(--focus); stroke: var(--focus); }
.carch .badge.on text { fill: #fff; }
.carch .pill rect { fill: var(--surface-1); stroke: var(--hairline-strong); }
.carch .pill text { fill: var(--text-primary); font-size: 10.5px; font-weight: 600; }
.carch .act { cursor: pointer; }
.carch .act:hover rect, .carch .act:focus-visible rect, .carch .act:hover circle { stroke: var(--focus); stroke-width: 1.8; }
.carch .act:focus { outline: none; }
.carch [data-target] { cursor: pointer; }
.carch [data-target]:focus { outline: none; }
.carch .hot .line, .carch .picked .line { stroke: var(--focus); stroke-width: 2.25; }
.carch .part.hot .ring, .carch .part.picked .ring, .carch .part:focus-visible .ring { stroke: var(--focus); stroke-width: 2; }
.carch svg.focusing .part:not(.hot):not(.near), .carch svg.focusing .link:not(.hot) { opacity: .35; transition: opacity .12s; }
@media (prefers-reduced-motion: reduce) { .carch svg.focusing .part, .carch svg.focusing .link { transition: none; } }
`;

interface ArchitectureChartViewProps {
  fsRef: FSRef;
  chart?: Chart;
  projectId?: string;
  changes?: ChartChanges;
}

export function ArchitectureChartView({ fsRef, chart, projectId, changes }: ArchitectureChartViewProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const sourceRef = useMemo(() => fsRef.child('architecture.json'), [fsRef]);
  const docRef = useMemo(() => fsRef.child('CHART.md'), [fsRef]);
  const [value, setValue] = useState<ArchValue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [step, setStep] = useState<number | null>(null);
  const [hot, setHot] = useState<{ target: string; title: string; sub: string; note?: string } | null>(null);
  const [picked, setPicked] = useState<{ id: string; label: string; at: { x: number; y: number } } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipPos = useRef({ x: 0, y: 0 });
  const openRef = useOpenChart(fsRef, projectId);

  const { folderName, dirPath } = useMemo(() => chartFolder(fsRef), [fsRef]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await sourceRef.readIfExists();
        if (!cancelled) setValue(parseArchitecture(raw));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setValue(parseArchitecture(null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceRef]);

  const layout = useMemo(() => (value ? layoutArchitecture(value) : null), [value]);
  const names = useMemo(() => (value ? namesOf(value) : new Map<string, string>()), [value]);
  const places = useMemo(() => (value ? partPlaces(value) : new Map<string, string>()), [value]);
  const mermaid = useMemo(() => (value ? architectureToMermaid(value) : ''), [value]);
  const pz = usePanZoom(layout?.width ?? 1, layout?.height ?? 1);
  const linksOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of layout?.links ?? []) for (const end of [l.link.from, l.link.to]) map.set(end, [...(map.get(end) ?? []), l.link.id]);
    return map;
  }, [layout]);
  // Per layout, not per render (hover re-renders many times a second).
  const legend = useMemo(
    () => ({
      roles: [...new Set((layout?.parts ?? []).map((p) => p.part.role))],
      dashed: (layout?.links ?? []).some((l) => l.link.style === 'dashed'),
    }),
    [layout],
  );
  const hotTarget = hot?.target;
  const focus = useMemo(() => {
    const link = hotTarget ? layout?.linkOf.get(hotTarget) : undefined;
    return {
      links: new Set(hotTarget ? (linksOf.get(hotTarget) ?? []) : []),
      near: new Set(link ? [link.link.from, link.link.to] : []),
    };
  }, [hotTarget, layout, linksOf]);

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
  const partCount = layout.parts.length;
  const { links: hotLinks, near } = focus;
  const markClass = (id: string) =>
    `${hot?.target === id || hotLinks.has(id) ? ' hot' : ''}${near.has(id) ? ' near' : ''}${picked?.id === id ? ' picked' : ''}`;
  const place = (x: number, y: number) => {
    tipPos.current = { x, y };
    if (tipRef.current) Object.assign(tipRef.current.style, tipStyle(x, y));
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
  const act = (fn: () => void) => chartAct(fn, 'button');
  const toggleStep = (n: number) => setStep((cur) => (cur === n ? null : n));
  const stepsOpen = step !== null && value.steps.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chart-architecture">
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
        className="carch relative min-h-0 flex-1"
        style={{ ...(tokens as React.CSSProperties), background: 'var(--surface-0)', color: 'var(--text-primary)' }}
      >
        <style>{STYLES}</style>
        <div className="absolute inset-0 overflow-auto">
          <div className="mx-auto max-w-[1640px] px-4 pb-6 pt-5">
            <header className="mb-4 flex flex-wrap items-end gap-4">
              <div className="min-w-[240px] flex-1">
                <ChartHeading title={value.title || chart?.name || folderName} description={chart?.description} />
                <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }} data-testid="chart-architecture-summary">
                  <span
                    className="me-2 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    <Trans>architecture</Trans>
                  </span>
                  <Trans>
                    {partCount} parts · {value.links.length} links · {value.steps.length} steps
                  </Trans>
                </p>
              </div>
              <ViewToggle view={view} onChange={setView} />
            </header>

            {view === 'chart' ? (
              <>
                <div className="relative overflow-hidden rounded-xl border" style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
                  <ZoomControls onFit={pz.fit} onIn={pz.zoomIn} onOut={pz.zoomOut} />
                  {stepsOpen && (
                    <aside
                      className="absolute bottom-3 end-3 z-[2] w-72 rounded-lg border p-2 shadow"
                      style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline-strong)' }}
                      data-testid="chart-architecture-steps"
                    >
                      <div className="mb-1 flex items-center justify-between px-1">
                        <span className="text-[13px] font-semibold">
                          <Trans>Steps</Trans>
                        </span>
                        <button
                          type="button"
                          className="text-xs"
                          style={{ color: 'var(--text-muted)' }}
                          onClick={() => setStep(null)}
                          aria-label={t`Close steps`}
                        >
                          ✕
                        </button>
                      </div>
                      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {value.steps.map((s) => (
                          <li key={s.n}>
                            <button
                              type="button"
                              onClick={() => setStep(s.n)}
                              className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-start text-[12px]"
                              style={s.n === step ? { background: 'var(--surface-2)' } : undefined}
                              data-testid="chart-architecture-step"
                              data-on={s.n === step ? 'true' : 'false'}
                            >
                              <span
                                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold"
                                style={s.n === step ? { background: 'var(--focus)', borderColor: 'var(--focus)', color: '#fff' } : { borderColor: 'var(--text-primary)' }}
                              >
                                {s.n}
                              </span>
                              <span>{s.text}</span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    </aside>
                  )}
                  <svg
                    ref={pz.svgRef}
                    xmlns="http://www.w3.org/2000/svg"
                    role="img"
                    className={`block${hot ? ' focusing' : ''}`}
                    style={{ width: '100%', height: 'calc(100dvh - 290px)', minHeight: 360 }}
                    viewBox={pz.viewBox}
                    data-zoomed={pz.zoomed ? 'true' : 'false'}
                    aria-label={t`${value.title || t`Architecture chart`}: ${partCount} parts, ${value.links.length} links`}
                    onPointerLeave={() => setHot(null)}
                    data-testid="chart-architecture-svg"
                    {...pz.handlers}
                  >
                    <defs>
                      <marker id="arch-ah" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={9} markerHeight={9} orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                        <path d="M1,1 L9,5 L1,9 Z" fill="var(--text-muted)" />
                      </marker>
                      <marker id="arch-ah-hot" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={10} markerHeight={10} orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                        <path d="M1,1 L9,5 L1,9 Z" fill="var(--focus)" />
                      </marker>
                    </defs>
                    <g>
                      {layout.groups.map(({ group: g, x, y, w, h }) => (
                        <g key={g.id} className={`grp${markClass(g.id)}`} data-testid="chart-architecture-group" {...handlers(g.id, g.label, g.label, g.sublabel ?? '')}>
                          <rect x={x} y={y} width={w} height={h} rx={4} />
                          <text className="glabel" x={x + w / 2} y={y + 18}>
                            {g.label}
                          </text>
                          {g.sublabel && (
                            <text className="gsub" x={x + w / 2} y={y + 33}>
                              {g.sublabel}
                            </text>
                          )}
                          <Marks ns={marksOf(g.id, g.label)} x={x + w - 14} y={y + 14} />
                        </g>
                      ))}
                      {layout.tiers.map(({ tier, x, y, w, h }) => (
                        <g key={tier.id} className="tier" data-testid="chart-architecture-tier">
                          <rect x={x} y={y} width={w} height={h} rx={4} />
                          {tier.label && (
                            <text className="tlabel" x={x + 10} y={y + 17}>
                              {tier.label}
                            </text>
                          )}
                        </g>
                      ))}
                    </g>
                    <g>
                      {layout.links.map(({ link: l, d, lx, ly }) => {
                        const isHot = hot?.target === l.id || hotLinks.has(l.id) || picked?.id === l.id;
                        const label = l.label ?? '';
                        const pw = label.length * 5.8 + 10;
                        return (
                          <g
                            key={l.id}
                            className={`link${l.style === 'dashed' ? ' dashed' : ''}${markClass(l.id)}`}
                            data-testid="chart-architecture-link"
                            aria-label={`${label || t`link`}, ${names.get(l.from) ?? l.from} → ${names.get(l.to) ?? l.to}`}
                            {...handlers(l.id, label || l.id, label || t`Link`, `${names.get(l.from) ?? l.from} → ${names.get(l.to) ?? l.to}`, l.note)}
                          >
                            <path d={d} className="hit" />
                            <path
                              d={d}
                              className="line"
                              markerEnd={`url(#${isHot ? 'arch-ah-hot' : 'arch-ah'})`}
                              markerStart={l.both ? `url(#${isHot ? 'arch-ah-hot' : 'arch-ah'})` : undefined}
                            />
                            {label && (
                              <>
                                <rect className="plate" x={lx - pw / 2} y={ly - 9} width={pw} height={14} rx={3} />
                                <text className="label" x={lx} y={ly + 2}>
                                  {label}
                                </text>
                              </>
                            )}
                          </g>
                        );
                      })}
                    </g>
                    <g>
                      {layout.parts.map(({ part: p, icon, x, w, h }) => {
                        const cx = x + w / 2;
                        const nameY = icon.y + icon.h + 16;
                        return (
                          <g
                            key={p.id}
                            className={`part${markClass(p.id)}`}
                            data-testid="chart-architecture-part"
                            data-role={p.role}
                            aria-label={`${p.role} ${p.label}`}
                            {...handlers(p.id, p.label, p.label, [p.sublabel, places.get(p.id)].filter(Boolean).join(' · '), p.note)}
                          >
                            <rect className="hit" x={x + 4} y={icon.y - 4} width={w - 8} height={h - 8} />
                            <rect className="ring" x={icon.x} y={icon.y} width={icon.w} height={icon.h} rx={9} fill={ARCH_ROLE_COLORS[p.role]} stroke="none" />
                            <foreignObject x={icon.x + 10} y={icon.y + 10} width={24} height={24} style={{ color: '#fff' }}>
                              <FlowIcon icon={ARCH_ROLE_ICON[p.role]} size={24} />
                            </foreignObject>
                            <text className="name" x={cx} y={nameY}>
                              {p.label}
                            </text>
                            {p.sublabel && (
                              <text className="sub" x={cx} y={nameY + 14}>
                                {p.sublabel}
                              </text>
                            )}
                            {p.step !== undefined && (
                              <g
                                {...act(() => toggleStep(p.step!))}
                                className={`act badge${step === p.step ? ' on' : ''}`}
                                data-testid="chart-architecture-badge"
                                aria-label={t`Step ${p.step}`}
                              >
                                <circle cx={icon.x - 10} cy={icon.y + 2} r={10} />
                                <text x={icon.x - 10} y={icon.y + 2.5}>
                                  {p.step}
                                </text>
                              </g>
                            )}
                            {p.ref && (
                              <g {...act(() => void openRef(p.ref!))} aria-label={t`Open ${p.label}`} data-testid="chart-architecture-open">
                                <g className="pill">
                                  <rect x={icon.x + icon.w + 2} y={icon.y - 6} width={46} height={18} rx={9} />
                                  <text x={icon.x + icon.w + 25} y={icon.y + 7} textAnchor="middle">
                                    {t`Open ↗`}
                                  </text>
                                </g>
                              </g>
                            )}
                            <Marks ns={marksOf(p.id, p.label)} x={icon.x + icon.w + 4} y={icon.y + icon.h - 6} />
                          </g>
                        );
                      })}
                    </g>
                  </svg>
                </div>
                <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }} data-testid="chart-architecture-legend">
                  {legend.roles.map((role) => (
                    <li key={role} className="flex items-center gap-1.5">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded" style={{ background: ARCH_ROLE_COLORS[role], color: '#fff' }}>
                        <FlowIcon icon={ARCH_ROLE_ICON[role]} size={11} />
                      </span>
                      {role}
                    </li>
                  ))}
                  {legend.dashed && (
                    <li className="flex items-center gap-1.5">
                      <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: 'var(--text-muted)' }} />
                      <Trans>async / optional</Trans>
                    </li>
                  )}
                  <li style={{ color: 'var(--text-muted)' }}>
                    <Trans>Scroll to zoom · drag to pan · click a number for the steps</Trans>
                  </li>
                </ul>
              </>
            ) : (
              <div className="space-y-4" data-testid="chart-table">
                {[
                  {
                    head: [t`Part`, t`Role`, t`Where`, t`Step`],
                    rows: layout.parts.map(({ part: p }) => ({
                      key: p.id,
                      cells: [[p.label, p.sublabel].filter(Boolean).join(' — '), p.role, places.get(p.id) ?? '', p.step ? String(p.step) : ''],
                    })),
                  },
                  {
                    head: [t`From`, t`To`, t`Link`],
                    rows: value.links.map((l) => ({
                      key: l.id,
                      cells: [names.get(l.from) ?? l.from, names.get(l.to) ?? l.to, `${l.label ?? ''}${l.style === 'dashed' ? ' (dashed)' : ''}`],
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
          <ChartTooltip ref={tipRef} at={tipPos.current}>
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
          </ChartTooltip>
        )}

        {picked && changes && (
          <ChartChangeBox
            label={picked.label}
            at={picked.at}
            onClose={() => setPicked(null)}
            onSubmit={(instruction, runNow) => {
              changes.request({ quote: elementQuote(picked.id, picked.label), instruction, runNow });
              setPicked(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

export default ArchitectureChartView;
