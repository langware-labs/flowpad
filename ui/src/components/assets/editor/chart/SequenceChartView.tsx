import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Chart, FSRef } from '@sdk';
import { FlowIcon } from '@sdk/react/FlowIcon';
import { Button } from '@src/components/ui/button';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { writeChartMermaid, autoNote } from './chartDoc';
import { ChartHeading } from './ChartHeading';
import { CHART_SLOTS as SLOTS, chartTokens } from './chartTheme';
import { useOpenChart } from './useOpenChart';
import { usePanZoom } from './usePanZoom';
import {
  ChangeWholeChart,
  ChartChangeBox,
  ChartTooltip,
  Marks,
  ViewToggle,
  ZoomControls,
  elementQuote,
  tipStyle,
  type ChartChanges,
} from './chartControls';
import {
  parseSequence,
  sequenceToMermaid,
  type SequenceMessage,
  type SequenceParticipant,
  type SequenceValue,
} from './sequenceToMermaid';

/**
 * A `sequence` chart: chart.json ({participants, messages}) drawn as a network-flow
 * sequence diagram.
 * Identity rides the categorical dot and the arrow colour (the sender's), never the text;
 * a message with `ref` is a sub-flow block whose "Open ↗" navigates to that chart.
 */

const AUTO_NOTE = autoNote('chart.json');

/** Sub-flow block height, and the Open ↗ pill — shared by layout and render. */
const SUB_H = 130;
const PILL = { w: 170, h: 58 };
/** A label's backing plate: its text box plus this padding. */
const PLATE_PAD = { x: 12, y: 4 };

/** How much larger the text is than the chart's base unit — sized to read at the fit-to-view zoom. */
const TEXT_SCALE = 3;
const px = (base: number) => `${base * TEXT_SCALE}px`;

const STYLES = `
.cseq svg text { font-family: inherit; }
.cseq .p rect.head { fill: var(--surface-1); stroke: var(--hairline-strong); stroke-width: 1; }
.cseq .p .name { fill: var(--text-primary); font-size: ${px(13)}; font-weight: 600; text-anchor: middle; }
.cseq .p .meta { fill: var(--text-muted); font-size: ${px(11)}; text-anchor: middle; }
.cseq .p .name.start, .cseq .p .meta.start { text-anchor: start; }
.cseq .head-strip { fill: var(--surface-1); }
.cseq .p .life { stroke: var(--hairline-strong); stroke-width: 1; }
.cseq .p .act { fill: var(--surface-2); stroke: var(--hairline-strong); stroke-width: 1; }
.cseq .m .line { fill: none; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
.cseq .m.reply .line { stroke-dasharray: 12 12; }
.cseq .m .hit { fill: none; stroke: transparent; stroke-width: 56; pointer-events: stroke; }
.cseq .m .label { fill: var(--text-primary); font-size: ${px(12.5)}; font-weight: 500; }
.cseq .m .num-bg { stroke: var(--surface-1); stroke-width: 2; }
.cseq .m .num { fill: #fff; font-size: ${px(10)}; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.cseq .m .lbl-bg { fill: var(--surface-1); }
.cseq .m.sub rect.block { fill: var(--surface-2); stroke: var(--hairline-strong); stroke-width: 1; stroke-dasharray: 4 3; }
.cseq .m.sub .tag { fill: var(--text-muted); font-size: ${px(10)}; font-weight: 700; letter-spacing: .08em; }
.cseq .m.sub .label { font-weight: 600; }
.cseq .m.sub .open rect { fill: var(--surface-1); stroke: var(--hairline-strong); }
.cseq .m.sub .open text { fill: var(--text-primary); font-size: ${px(11)}; font-weight: 600; }
.cseq .m.sub .open:hover rect, .cseq .m.sub .open:focus-visible rect { stroke: var(--focus); stroke-width: 2; }
.cseq .m.sub .open { cursor: pointer; }
.cseq .m.hot .line { stroke-width: 7; }
.cseq .m.hot .label { font-weight: 700; }
.cseq .m.hot .lbl-bg { stroke: var(--focus); stroke-width: 2; }
.cseq .m.hot .num-bg { stroke: var(--focus); stroke-width: 3; }
.cseq .p.hot rect.head { stroke: var(--focus); stroke-width: 3; }
.cseq .m:focus, .cseq .p:focus { outline: none; }
.cseq svg { touch-action: none; }
.cseq [data-target] { cursor: pointer; }
.cseq .p.picked rect.head, .cseq .m.picked .lbl-bg, .cseq .m.sub.picked rect.block { stroke: var(--focus); stroke-width: 2; }
.cseq .popen { cursor: pointer; }
.cseq .popen rect { fill: var(--surface-1); stroke: var(--hairline-strong); }
.cseq .popen text { fill: var(--text-primary); font-size: ${px(11)}; font-weight: 600; }
.cseq .popen:hover rect, .cseq .popen:focus-visible rect { stroke: var(--focus); stroke-width: 2; }
.cseq .m:focus-visible .lbl-bg, .cseq .p:focus-visible rect.head { stroke: var(--focus); stroke-width: 2; }
`;

interface Info {
  n: string;
  label: string;
  from: string;
  to: string;
  self: boolean;
  color: string;
  note?: string;
  participant?: boolean;
}

type Item =
  | {
      kind: 'arrow';
      key: string;
      target: string;
      label: string;
      n: string;
      color: string;
      marker: number;
      d: string;
      reply: boolean;
      lx: number;
      ly: number;
      anchor: 'start' | 'middle';
      nx: number;
      ny: number;
      info: Info;
    }
  | {
      kind: 'sub';
      key: string;
      target: string;
      label: string;
      n: string;
      color: string;
      ref: string;
      lo: number;
      hi: number;
      y: number;
      info: Info;
    };

interface Lane {
  p: SequenceParticipant;
  x: number;
  lines: string[];
  /** Where the card's text sits, and how many characters of name / meta fit before the ellipsis. */
  text: { x: number; anchor: 'start' | 'middle'; max: [number, number] };
  color: string;
  info: Info;
}

/** A card line that fits its card: longer text ends in an ellipsis (the full text is in the tooltip). */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The diagram's geometry — the same constants and rules as the chartit template. */
export function layoutSequence(value: SequenceValue) {
  const P = value.participants;
  const M = value.messages;
  const color: Record<string, string> = {};
  const idx: Record<string, number> = {};
  P.forEach((p, i) => {
    color[p.id] = `var(${SLOTS[i] ?? '--s-other'})`;
    idx[p.id] = i;
  });
  // Text is drawn 3× the chart's base size (TEXT_SCALE); the cards, rows and lane gaps grow
  // with the text they hold, so it stays readable at the zoom that fits the whole chart.
  const NAME_CHAR_W = 7.6 * TEXT_SCALE; // 39px name
  const META_CHAR_W = 6.4 * TEXT_SCALE; // 33px meta
  const MARGIN = 60;
  const DOT_X = 30;
  const ICON_X = 56;
  const ICON_SIZE = 56;
  const TEXT_X = 128;
  const longest = Math.max(
    0,
    ...P.map((p) => Math.max(p.label.length * NAME_CHAR_W, (p.sublabel ?? '').length * META_CHAR_W)),
  );
  const HEAD_W = Math.min(720, Math.max(380, Math.ceil(longest + TEXT_X + 30)));
  const HEAD_H = 130;
  // Lanes are sized by their cards only: a long arrow label runs past its lanes on its plate, so the
  // text keeps its size at the zoom that fits the chart's width.
  const COL = HEAD_W + 40;
  const TOP = 40;
  const ROW = 120;
  const SELF = 150;
  const END = 60;
  const cx = (id: string) => MARGIN + HEAD_W / 2 + idx[id] * COL;
  const name = (id: string) => P[idx[id]].label;

  const items: Item[] = [];
  let y = TOP + HEAD_H + 90;
  M.forEach((m: SequenceMessage, i) => {
    if (!(m.from in idx) || !(m.to in idx)) return;
    const self = m.from === m.to;
    const x1 = cx(m.from);
    const x2 = cx(m.to);
    const c = color[m.from];
    const n = String(i + 1);
    if (m.ref) {
      const lo = Math.min(x1, x2) - HEAD_W / 2 + 14;
      const hi = Math.max(x1, x2) + HEAD_W / 2 - 14;
      const h = SUB_H;
      items.push({
        kind: 'sub',
        key: m.id,
        target: m.id,
        label: m.label,
        n,
        color: c,
        ref: m.ref,
        lo,
        hi,
        y,
        info: { n, label: m.label, from: name(m.from), to: name(m.to), self, color: c, note: m.note },
      });
      y += h + 50;
      if (m.returns && !self) {
        const dir = x1 > x2 ? 1 : -1;
        const rn = `${i + 1}′`;
        items.push({
          kind: 'arrow',
          key: `${m.id}.out`,
          target: `${m.id}.out`,
          label: m.returns,
          n: rn,
          color: color[m.to],
          marker: idx[m.to],
          d: `M${x2 + dir * 6},${y} L${x1 - dir * 6},${y}`,
          reply: true,
          lx: (x1 + x2) / 2,
          ly: y - 24,
          anchor: 'middle',
          nx: NaN,
          ny: y,
          info: {
            n: rn,
            label: `${m.returns} (output of ${m.label})`,
            from: name(m.to),
            to: name(m.from),
            self: false,
            color: color[m.to],
            note: m.note,
          },
        });
        y += ROW;
      }
      return;
    }
    let d: string;
    let lx: number;
    let ly: number;
    let anchor: 'start' | 'middle';
    if (self) {
      const w = 100;
      const h = SELF - 40;
      d = `M${x1 + 6},${y} h${w - 24} q24,0 24,24 v${h - 48} q0,24 -24,24 h${-(w - 24)}`;
      lx = x1 + w + 30;
      ly = y + h / 2 + 12;
      anchor = 'start';
    } else {
      const dir = x2 > x1 ? 1 : -1;
      d = `M${x1 + dir * 6},${y} L${x2 - dir * 6},${y}`;
      lx = (x1 + x2) / 2;
      ly = y - 24;
      anchor = 'middle';
    }
    // the step number sits at the start of the arrow (Mermaid's autonumber)
    const nx = self ? x1 + 6 : x1 + (x2 > x1 ? 40 : -40);
    items.push({
      kind: 'arrow',
      key: m.id,
      target: m.id,
      label: m.label,
      n,
      color: c,
      marker: idx[m.from],
      d,
      reply: m.style === 'dashed',
      lx,
      ly,
      anchor,
      nx,
      ny: y,
      info: { n, label: m.label, from: name(m.from), to: name(m.to), self, color: c, note: m.note },
    });
    y += self ? SELF + 50 : ROW;
  });
  const bottom = y + END;
  const lanes: Lane[] = P.map((p) => {
    const x = cx(p.id);
    const lines = [p.label, p.sublabel].filter(Boolean) as string[];
    const room = p.icon ? HEAD_W - TEXT_X - 20 : HEAD_W - 80;
    return {
      p,
      x,
      lines,
      text: {
        x: p.icon ? x - HEAD_W / 2 + TEXT_X : x + 6,
        anchor: p.icon ? 'start' : 'middle',
        max: [Math.floor(room / NAME_CHAR_W), Math.floor(room / META_CHAR_W)],
      },
      color: color[p.id],
      info: {
        n: '',
        label: lines.join(' · '),
        from: '',
        to: '',
        self: false,
        color: color[p.id],
        note: p.note,
        participant: true,
      },
    };
  });
  const width = MARGIN * 2 + HEAD_W + Math.max(0, P.length - 1) * COL + 120;
  const laneOf = new Map(lanes.map((l) => [l.p.id, l]));
  const itemOf = new Map(items.map((i) => [i.target, i]));
  return {
    lanes,
    items,
    laneOf,
    itemOf,
    width,
    height: bottom + 8,
    bottom,
    TOP,
    HEAD_W,
    HEAD_H,
    DOT_X,
    ICON_X,
    ICON_SIZE,
    color,
    idx,
  };
}

/** Width of a label plate before layout can be measured (jsdom, first paint). */
const estimate = (text: string) => text.length * 6.8 * TEXT_SCALE;

interface SequenceChartViewProps {
  fsRef: FSRef;
  chart?: Chart;
  projectId?: string;
  actions?: React.ReactNode;
  /** Pick a participant or message → "Change this" → the chart's Changes tab and context worker. */
  changes?: ChartChanges;
}

export function SequenceChartView({ fsRef, chart, projectId, actions, changes }: SequenceChartViewProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const chartRef = useMemo(() => fsRef.child('chart.json'), [fsRef]);
  const docRef = useMemo(() => fsRef.child('CHART.md'), [fsRef]);
  const [value, setValue] = useState<SequenceValue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  // What the pointer is on: changes only when the target does. The tooltip follows the pointer
  // through `tipPos` and its element's style, not a render per pixel.
  const [hot, setHot] = useState<{ target: string; info: Info } | null>(null);
  const tipPos = useRef({ x: 0, y: 0 });
  const tipRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [picked, setPicked] = useState<{ id: string; label: string; at: { x: number; y: number } } | null>(null);
  const [plates, setPlates] = useState<Record<string, { x: number; y: number; width: number; height: number }>>({});

  const { folderName, dirPath } = useMemo(() => {
    const parts = (fsRef.path || '').split('/').filter(Boolean);
    const tail = parts.pop() || 'chart';
    return { folderName: tail, dirPath: parts.length ? '/' + parts.join('/') : '' };
  }, [fsRef]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await chartRef.readIfExists();
        if (!cancelled) setValue(parseSequence(raw));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setValue({ participants: [], messages: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chartRef]);

  const layout = useMemo(() => (value ? layoutSequence(value) : null), [value]);
  const pz = usePanZoom(layout?.width ?? 1, layout?.height ?? 1, { fitWidth: true });
  const setPzSvg = pz.svgRef;
  // A stable ref: an inline one re-attaches (and re-sets pan-zoom state) on every render.
  const attachSvg = useCallback(
    (el: SVGSVGElement | null) => {
      svgRef.current = el;
      setPzSvg(el);
    },
    [setPzSvg],
  );

  // label plates: measured after layout, so text never sits on a line
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (view !== 'chart' || !svg) return;
    const next: typeof plates = {};
    svg.querySelectorAll<SVGTextElement>('text[data-plate]').forEach((node) => {
      if (typeof node.getBBox !== 'function') return;
      const b = node.getBBox();
      if (!b.width) return;
      next[node.dataset.plate!] = {
        x: b.x - PLATE_PAD.x,
        y: b.y - PLATE_PAD.y,
        width: b.width + PLATE_PAD.x * 2,
        height: b.height + PLATE_PAD.y * 2,
      };
    });
    setPlates((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }, [layout, view]);

  const openRef = useOpenChart(fsRef, projectId);

  const regenerateDoc = useCallback(async () => {
    if (!value) return;
    await writeChartMermaid(docRef, chart, sequenceToMermaid(value), AUTO_NOTE);
  }, [docRef, chart, value]);

  if (!value || !layout) {
    return (
      <div
        data-testid="chart-loading"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        <RefreshCw className="me-2 h-4 w-4 animate-spin" />
        <Trans>Loading chart…</Trans>
      </div>
    );
  }

  const { lanes, items, bottom, TOP, HEAD_W, HEAD_H, DOT_X, ICON_X, ICON_SIZE } = layout;
  const tokens = chartTokens(resolvedTheme);
  const moveTip = (target: string, info: Info, x: number, y: number) => {
    tipPos.current = { x, y };
    const el = tipRef.current;
    if (el) Object.assign(el.style, tipStyle(x, y));
    setHot((cur) => (cur?.target === target ? cur : { target, info }));
  };
  const showTip = (target: string, info: Info, e: { clientX: number; clientY: number }) =>
    moveTip(target, info, e.clientX, e.clientY);
  const focusTip = (target: string, info: Info, el: Element) => {
    const b = el.getBoundingClientRect();
    moveTip(target, info, b.left + b.width / 2, b.top);
  };
  const markClass = (id: string) => `${hot?.target === id ? ' hot' : ''}${picked?.id === id ? ' picked' : ''}`;
  const pick = (id: string, label: string, e: { clientX: number; clientY: number }) => {
    if (!changes) return;
    setHot(null);
    setPicked((cur) => (cur?.id === id ? null : { id, label, at: { x: e.clientX + 12, y: e.clientY + 12 } }));
  };
  const marksOf = (id: string, label: string) => changes?.marks.get(elementQuote(id, label));
  const openPill = (fn: () => void) => ({
    className: 'popen',
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
  const plateFor = (key: string, text: string, x: number, y: number, anchor: 'start' | 'middle') =>
    plates[key] ?? {
      x: (anchor === 'middle' ? x - estimate(text) / 2 : x) - PLATE_PAD.x,
      y: y - 40,
      width: estimate(text) + PLATE_PAD.x * 2,
      height: 54,
    };
  const keyActivate = (e: React.KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
  const nameOf = (id: string) => layout.laneOf.get(id)?.p.label ?? id;
  const colorOf = (id: string) => layout.color[id] ?? 'var(--s-other)';

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chart-sequence">
      <AssetEditorHeader
        fileName={folderName}
        dirPath={dirPath}
        onOpenExternal={() => void fsRef.open()}
        onRevealInFinder={() => void fsRef.open({ select: true })}
        actions={
          <>
            {changes && <ChangeWholeChart changes={changes} />}
            {actions}
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
        className="cseq relative min-h-0 flex-1"
        style={{ ...(tokens as React.CSSProperties), background: 'var(--surface-0)', color: 'var(--text-primary)' }}
      >
        <style>{STYLES}</style>
        <div className="absolute inset-0 overflow-auto">
          <div className="mx-auto max-w-[1640px] px-4 pb-28 pt-5">
            <header className="mb-4 flex flex-wrap items-end gap-4">
              <div className="min-w-[240px] flex-1">
                <ChartHeading title={value.title || chart?.name || folderName} description={chart?.description} />
                <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  <Trans>
                    {value.participants.length} participants · {value.messages.length} messages
                  </Trans>
                </p>
              </div>
              <ViewToggle view={view} onChange={setView} />
            </header>

            {view === 'chart' ? (
              <div
                className="relative overflow-hidden rounded-xl border"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
              >
                <ZoomControls onFit={pz.fit} onIn={pz.zoomIn} onOut={pz.zoomOut} />
                <svg
                  ref={attachSvg}
                  {...pz.handlers}
                  xmlns="http://www.w3.org/2000/svg"
                  role="img"
                  className="block"
                  style={{ width: '100%', height: 'calc(100dvh - 290px)', minHeight: 360 }}
                  viewBox={pz.viewBox}
                  data-zoomed={pz.zoomed ? 'true' : 'false'}
                  aria-label={t`${value.title || t`Sequence chart`}: ${value.participants.length} participants, ${value.messages.length} messages`}
                  onPointerLeave={() => setHot(null)}
                  data-testid="chart-sequence-svg"
                >
                  <defs>
                    {lanes.map((lane, i) => (
                      <marker
                        key={lane.p.id}
                        id={`ah-${i}`}
                        viewBox="0 0 10 10"
                        refX={9}
                        refY={5}
                        markerWidth={26}
                        markerHeight={26}
                        orient="auto-start-reverse"
                        markerUnits="userSpaceOnUse"
                      >
                        <path d="M1,1 L9,5 L1,9 Z" fill={lane.color} strokeLinejoin="round" />
                      </marker>
                    ))}
                  </defs>
                  <g>
                    {lanes.map((lane) => (
                      <g key={lane.p.id} className="p" aria-hidden="true">
                        <line className="life" x1={lane.x} y1={TOP + HEAD_H} x2={lane.x} y2={bottom} />
                        <rect className="act" x={lane.x - 8} y={bottom - 12} width={16} height={12} rx={4} />
                      </g>
                    ))}
                  </g>
                  <g>
                    {items.map((item) => {
                      const common = {
                        'data-target': item.target,
                        'data-label': item.label,
                        tabIndex: 0,
                        role: 'listitem',
                        onPointerMove: (e: React.PointerEvent) => showTip(item.target, item.info, e),
                        onFocus: (e: React.FocusEvent<SVGGElement>) =>
                          focusTip(item.target, item.info, e.currentTarget),
                        onBlur: () => setHot(null),
                        onClick: (e: React.MouseEvent) => pick(item.target, item.label, e),
                      };
                      if (item.kind === 'sub') {
                        const { lo, hi, y } = item;
                        return (
                          <g
                            key={item.key}
                            className={`m sub${markClass(item.target)}`}
                            aria-label={`${item.n}. Sub-flow ${item.label}`}
                            data-testid="chart-subflow"
                            {...common}
                          >
                            <rect className="block" x={lo} y={y - 45} width={hi - lo} height={SUB_H} rx={20} />
                            <circle className="num-bg" cx={lo + 45} cy={y + 20} r={24} fill={item.color} />
                            <text className="num" x={lo + 45} y={y + 21}>
                              {item.n}
                            </text>
                            <text className="tag" x={lo + 90} y={y + 5}>
                              <Trans>SUB-FLOW</Trans>
                            </text>
                            <text className="label" x={lo + 90} y={y + 50}>
                              {item.label}
                            </text>
                            <g
                              className="open"
                              data-open={item.ref}
                              tabIndex={0}
                              role="link"
                              aria-label={t`Open ${item.label}`}
                              data-testid="chart-subflow-open"
                              onClick={(e) => {
                                e.stopPropagation();
                                void openRef(item.ref);
                              }}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                keyActivate(e, () => void openRef(item.ref));
                              }}
                            >
                              <rect x={hi - 30 - PILL.w} y={y - 10} width={PILL.w} height={PILL.h} rx={PILL.h / 2} />
                              <text x={hi - 30 - PILL.w / 2} y={y + 32} textAnchor="middle">
                                {t`Open ↗`}
                              </text>
                            </g>
                            <Marks ns={marksOf(item.target, item.label)} x={hi - 220} y={y - 40} />
                          </g>
                        );
                      }
                      const plate = plateFor(item.key, item.label, item.lx, item.ly, item.anchor);
                      return (
                        <g
                          key={item.key}
                          className={`m ${item.reply ? 'reply' : ''}${markClass(item.target)}`}
                          aria-label={`${item.n}. ${item.label}, from ${item.info.from} to ${item.info.to}`}
                          data-testid="chart-message"
                          {...common}
                        >
                          <path d={item.d} className="hit" />
                          <path d={item.d} className="line" stroke={item.color} markerEnd={`url(#ah-${item.marker})`} />
                          <rect className="lbl-bg" rx={4} {...plate} />
                          <text
                            className="label"
                            data-plate={item.key}
                            x={item.lx}
                            y={item.ly}
                            textAnchor={item.anchor}
                          >
                            {item.label}
                          </text>
                          {!Number.isNaN(item.nx) && (
                            <>
                              <circle className="num-bg" cx={item.nx} cy={item.ny} r={24} fill={item.color} />
                              <text className="num" x={item.nx} y={item.ny + 1}>
                                {item.n}
                              </text>
                            </>
                          )}
                          <Marks
                            ns={marksOf(item.target, item.label)}
                            x={plate.x + plate.width + 24}
                            y={plate.y + plate.height / 2}
                          />
                        </g>
                      );
                    })}
                  </g>
                  {/* The cards stay pinned to the top of the view: they pan and zoom with their columns
                      across, never scroll away down. A strip behind them hides what passes under. */}
                  <g transform={`translate(0 ${Math.max(0, pz.visibleTop)})`} data-testid="chart-sequence-head">
                    <rect
                      className="head-strip"
                      x={-layout.width}
                      y={0}
                      width={layout.width * 3}
                      height={TOP * 2 + HEAD_H}
                    />
                    {lanes.map((lane) => {
                      const base = TOP + HEAD_H / 2 + (lane.lines.length > 1 ? -8 : 13);
                      return (
                        <g
                          key={lane.p.id}
                          className={`p${markClass(lane.p.id)}`}
                          data-target={lane.p.id}
                          data-label={lane.lines[0]}
                          tabIndex={0}
                          role="listitem"
                          aria-label={`Participant ${lane.lines.join(' ')}`}
                          data-testid="chart-participant"
                          onPointerMove={(e) => showTip(lane.p.id, lane.info, e)}
                          onFocus={(e) => focusTip(lane.p.id, lane.info, e.currentTarget)}
                          onBlur={() => setHot(null)}
                          onClick={(e) => pick(lane.p.id, lane.lines[0], e)}
                          onKeyDown={(e) =>
                            keyActivate(e, () => {
                              const b = e.currentTarget.getBoundingClientRect();
                              pick(lane.p.id, lane.lines[0], { clientX: b.left + b.width / 2, clientY: b.bottom });
                            })
                          }
                        >
                          <rect
                            className="head"
                            x={lane.x - HEAD_W / 2}
                            y={TOP}
                            width={HEAD_W}
                            height={HEAD_H}
                            rx={20}
                          />
                          <circle cx={lane.x - HEAD_W / 2 + DOT_X} cy={TOP + HEAD_H / 2} r={12} fill={lane.color} />
                          {lane.p.icon && (
                            // The participant's own mark (an IconSpec tag); identity still rides the dot.
                            <foreignObject
                              x={lane.x - HEAD_W / 2 + ICON_X}
                              y={TOP + (HEAD_H - ICON_SIZE) / 2}
                              width={ICON_SIZE}
                              height={ICON_SIZE}
                            >
                              <FlowIcon icon={lane.p.icon} size={ICON_SIZE} title={lane.p.label} />
                            </foreignObject>
                          )}
                          <text
                            className={lane.text.anchor === 'start' ? 'name start' : 'name'}
                            x={lane.text.x}
                            y={base}
                          >
                            {clip(lane.lines[0], lane.text.max[0])}
                          </text>
                          {lane.lines[1] && (
                            <text
                              className={lane.text.anchor === 'start' ? 'meta start' : 'meta'}
                              x={lane.text.x}
                              y={base + 42}
                            >
                              {clip(lane.lines[1], lane.text.max[1])}
                            </text>
                          )}
                          {lane.p.ref && (
                            <g
                              {...openPill(() => void openRef(lane.p.ref!))}
                              aria-label={t`Open ${lane.lines[0]}`}
                              data-testid="chart-participant-open"
                            >
                              <rect
                                x={lane.x - PILL.w / 2}
                                y={TOP + HEAD_H + 14}
                                width={PILL.w}
                                height={PILL.h}
                                rx={PILL.h / 2}
                              />
                              <text x={lane.x} y={TOP + HEAD_H + 54} textAnchor="middle">
                                {t`Open ↗`}
                              </text>
                            </g>
                          )}
                          <Marks ns={marksOf(lane.p.id, lane.lines[0])} x={lane.x - HEAD_W / 2 + 2} y={TOP + 2} />
                        </g>
                      );
                    })}
                  </g>
                </svg>
              </div>
            ) : (
              <div
                className="overflow-auto rounded-xl border"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
              >
                <table className="w-full border-collapse text-[13px]" data-testid="chart-table">
                  <thead>
                    <tr>
                      {[t`#`, t`From`, t`To`, t`Message`].map((h) => (
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
                    {value.messages.map((m, i) => (
                      <tr key={m.id ?? i} data-testid="chart-table-row">
                        {[String(i + 1), m.from, m.to, m.label + (m.note ? ` — ${m.note}` : '')].map((cell, k) => (
                          <td
                            key={k}
                            className="px-3.5 py-2"
                            style={{
                              borderBottom: '1px solid var(--hairline)',
                              color: k === 0 ? 'var(--text-muted)' : undefined,
                            }}
                          >
                            {(k === 1 || k === 2) && (
                              <span
                                className="me-2 inline-block h-2 w-2 rounded-full align-[1px]"
                                style={{ background: colorOf(cell) }}
                              />
                            )}
                            {k === 1 || k === 2 ? nameOf(cell) : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

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

        {hot && !picked && (
          <ChartTooltip ref={tipRef} at={tipPos.current}>
            {hot.info.participant ? (
              <>
                <span className="block text-[13px] font-semibold">{hot.info.label}</span>
                <span className="mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                  <Trans>Participant</Trans>
                </span>
              </>
            ) : (
              <>
                <span className="block text-[13px] font-semibold">
                  {hot.info.n}. {hot.info.label}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                  <span className="inline-block h-0.5 w-3.5 rounded-sm" style={{ background: hot.info.color }} />
                  {hot.info.self ? t`${hot.info.from} (self-call)` : `${hot.info.from} → ${hot.info.to}`}
                </span>
              </>
            )}
            {hot.info.note && (
              <span className="mt-1 block" style={{ color: 'var(--text-muted)' }}>
                {hot.info.note}
              </span>
            )}
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

export default SequenceChartView;
