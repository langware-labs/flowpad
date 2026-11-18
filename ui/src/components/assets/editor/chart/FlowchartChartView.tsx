import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Chart, FSRef } from '@sdk';
import { autoNote } from './chartDoc';
import { ChartCanvas, ChartFrame, ChartLoading, ChartSidePanel, ChartTable, useChartView } from './chartBase';
import { Marks, chartAct, type ChartChanges } from './chartControls';
import {
  FLOW_NODE,
  flowchartToMermaid,
  layoutFlowchart,
  parseFlowchart,
  type FlowBox,
  type FlowLayout,
  type FlowchartValue,
} from './flowchartModel';
import { useOpenChart } from './useOpenChart';
import { usePanZoom } from './usePanZoom';

/**
 * A `flowchart` chart: flowchart.json ({nodes, edges, notes}) drawn as a decision flow on the
 * shared chart frame. The canvas holds only short questions and outcomes; each question's number
 * links it to its State row beside the canvas, and details live in Notes — never in the flow.
 */

const AUTO_NOTE = autoNote('flowchart.json');
const PILL_W = 84;

const STYLES = `
.cflow svg text { font-family: inherit; }
.cflow svg { touch-action: none; }
.cflow .node .body { fill: var(--surface-1); stroke: var(--hairline-strong); stroke-width: 1; }
.cflow .node.question .body { stroke: var(--s1); stroke-width: 1.5; }
.cflow .node.start .body { fill: var(--surface-2); }
.cflow .node .name { fill: var(--text-primary); font-size: 15px; font-weight: 600; text-anchor: middle; }
.cflow .node.hot .body, .cflow .node.picked .body { stroke: var(--focus); stroke-width: 2.5; }
.cflow .node:focus { outline: none; }
.cflow .node:focus-visible .body { stroke: var(--focus); stroke-width: 2.5; }
.cflow .num-bg { fill: var(--s1); stroke: var(--surface-1); stroke-width: 2; }
.cflow .num { fill: #fff; font-size: 11px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.cflow .edge .line { fill: none; stroke: var(--text-muted); stroke-width: 1.5; }
.cflow .edge .plate { fill: var(--surface-1); stroke: var(--hairline); }
.cflow .edge .label { fill: var(--text-secondary); font-size: 12.5px; font-weight: 600; text-anchor: middle; dominant-baseline: central; }
.cflow .edge.hot .line { stroke: var(--focus); stroke-width: 2.25; }
.cflow .act { cursor: pointer; }
.cflow .act rect { fill: var(--surface-1); stroke: var(--hairline-strong); }
.cflow .act text { fill: var(--text-primary); font-size: 10.5px; font-weight: 600; text-anchor: middle; }
.cflow .act:hover rect, .cflow .act:focus-visible rect { stroke: var(--focus); stroke-width: 1.5; }
.cflow .act:focus { outline: none; }
.cflow [data-target] { cursor: pointer; }
`;

interface Info {
  n?: string;
  label: string;
  kind: string;
  state?: string;
  note?: string;
}

interface FlowchartChartViewProps {
  fsRef: FSRef;
  chart?: Chart;
  projectId?: string;
  /** Pick a node → "Change this" → the chart's Changes tab and context worker. */
  changes?: ChartChanges;
}

/** A node's outline: a diamond for a question, a pill for the start, a box for the rest. */
function Body({ box }: { box: FlowBox }) {
  const { x, y, w, h, node } = box;
  if (node.kind === 'question') {
    return <path className="body" d={`M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z`} />;
  }
  return <rect className="body" x={x} y={y} width={w} height={h} rx={node.kind === 'start' ? h / 2 : 10} />;
}

export function FlowchartChartView({ fsRef, chart, projectId, changes }: FlowchartChartViewProps) {
  const { t } = useLingui();
  const base = useChartView<FlowchartValue, Info>(fsRef, chart, 'flowchart.json', parseFlowchart, changes);
  const { value, hot, setHot, markClass, marksOf, element, setLoadError } = base;
  const [layout, setLayout] = useState<FlowLayout | null>(null);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    layoutFlowchart(value).then(
      (next) => !cancelled && setLayout(next),
      (err: unknown) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [value, setLoadError]);
  // Fit = the full width: a tall flow is panned down, never shrunk until its text is unreadable.
  const pz = usePanZoom(layout?.width ?? 1, layout?.height ?? 1, { fitWidth: true });
  const openRef = useOpenChart(fsRef, projectId);

  const kindName = useMemo<Record<string, string>>(
    () => ({ start: t`Start`, question: t`Question`, outcome: t`Outcome`, step: t`Step` }),
    [t],
  );
  const sections = useMemo(() => {
    const boxes = layout?.boxes ?? [];
    return [
      {
        id: 'state',
        title: t`State`,
        rows: boxes
          .filter((b) => b.node.state)
          .map((b) => ({ target: b.node.id, n: b.n, title: b.node.label, text: b.node.state! })),
      },
      {
        id: 'notes',
        title: t`Notes`,
        rows: [
          ...boxes
            .filter((b) => b.node.note)
            .map((b) => ({ target: b.node.id, n: b.n, title: b.node.label, text: b.node.note! })),
          ...(value?.notes ?? []).map((text) => ({ text })),
        ],
      },
    ];
  }, [layout, value, t]);

  if (!value || !layout) return <ChartLoading />;

  const infoOf = (box: FlowBox): Info => ({
    n: box.n,
    label: box.node.label,
    kind: kindName[box.node.kind],
    state: box.node.state,
    note: box.node.note,
  });
  const { questions } = layout;
  const exitsOf = (id: string) =>
    value.edges
      .filter((e) => e.from === id)
      .map((e) => `${e.label ? `${e.label} → ` : '→ '}${layout.boxOf.get(e.to)?.node.label ?? e.to}`)
      .join(' · ');
  const hotId = hot?.target ?? null;

  return (
    <ChartFrame
      fsRef={fsRef}
      chart={chart}
      testId="chart-flowchart"
      scope="cflow"
      styles={STYLES}
      title={value.title}
      summary={
        <Trans>
          {questions} questions · {value.nodes.length} steps
        </Trans>
      }
      changes={changes}
      base={base}
      mermaid={() => flowchartToMermaid(value)}
      note={AUTO_NOTE}
      zoom={pz}
      side={
        <ChartSidePanel
          sections={sections}
          hot={hotId}
          onHot={(id) => {
            const box = id ? layout.boxOf.get(id) : undefined;
            setHot(box ? { target: box.node.id, info: infoOf(box) } : null);
          }}
        />
      }
      table={() => (
        <ChartTable
          head={[t`#`, t`Step`, t`State`, t`Leads to`, t`Note`]}
          rows={layout.boxes.map((b) => ({
            key: b.node.id,
            cells: [b.n ?? '', b.node.label, b.node.state ?? '', exitsOf(b.node.id), b.node.note ?? ''],
          }))}
        />
      )}
      tooltip={
        // Hovering a side row lights its node; the tooltip is for the pointer on the canvas.
        hot && (
          <>
            <span className="block text-[13px] font-semibold">
              {hot.info.n ? `${hot.info.n}. ` : ''}
              {hot.info.label}
            </span>
            <span className="mt-0.5 block" style={{ color: 'var(--text-secondary)' }}>
              {hot.info.kind}
              {hot.info.state ? ` · ${hot.info.state}` : ''}
            </span>
            {hot.info.note && (
              <span className="mt-1 block" style={{ color: 'var(--text-muted)' }}>
                {hot.info.note}
              </span>
            )}
          </>
        )
      }
    >
      <ChartCanvas
        pz={pz}
        label={t`${value.title || t`Flowchart`}: ${questions} questions, ${value.nodes.length} steps`}
        testId="chart-flowchart-svg"
        onLeave={() => setHot(null)}
      >
        <defs>
          <marker
            id="flow-ah"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={9}
            markerHeight={9}
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path d="M1,1 L9,5 L1,9 Z" fill="var(--text-muted)" />
          </marker>
        </defs>
        <g>
          {layout.lines.map((line) => (
            <g
              key={line.key}
              className={`edge${hotId === line.edge.from || hotId === line.edge.to ? ' hot' : ''}`}
              data-testid="chart-flow-edge"
              data-from={line.edge.from}
              data-to={line.edge.to}
              aria-hidden="true"
            >
              <path d={line.d} className="line" markerEnd="url(#flow-ah)" />
              {line.edge.label && (
                <>
                  <rect className="plate" x={line.lx - line.lw / 2} y={line.ly - 11} width={line.lw} height={22} rx={11} />
                  <text className="label" x={line.lx} y={line.ly}>
                    {line.edge.label}
                  </text>
                </>
              )}
            </g>
          ))}
        </g>
        <g>
          {layout.boxes.map((box) => {
            const { node, x, y, w, h } = box;
            const textTop = y + (h - box.pill - box.lines.length * FLOW_NODE.LINE) / 2 + FLOW_NODE.LINE * 0.72;
            return (
              <g
                key={node.id}
                className={`node ${node.kind}${markClass(node.id)}`}
                aria-label={`${box.n ? `${box.n}. ` : ''}${node.label}`}
                data-testid="chart-flow-node"
                data-kind={node.kind}
                {...element(node.id, node.label, infoOf(box))}
              >
                <Body box={box} />
                {box.lines.map((line, i) => (
                  <text key={i} className="name" x={x + w / 2} y={textTop + i * FLOW_NODE.LINE}>
                    {line}
                  </text>
                ))}
                {box.n && (
                  <g data-testid="chart-flow-number">
                    <circle className="num-bg" cx={x + w / 2} cy={y} r={11} />
                    <text className="num" x={x + w / 2} y={y + 0.5}>
                      {box.n}
                    </text>
                  </g>
                )}
                {node.ref && (
                  <g
                    {...chartAct(() => void openRef(node.ref!))}
                    aria-label={t`Open ${node.label}`}
                    data-testid="chart-flow-open"
                  >
                    <rect
                      x={x + w / 2 - PILL_W / 2}
                      y={y + h - FLOW_NODE.PILL_H - 10}
                      width={PILL_W}
                      height={FLOW_NODE.PILL_H}
                      rx={FLOW_NODE.PILL_H / 2}
                    />
                    <text x={x + w / 2} y={y + h - FLOW_NODE.PILL_H / 2 - 6}>
                      {t`Open ↗`}
                    </text>
                  </g>
                )}
                <Marks ns={marksOf(node.id, node.label)} x={x + 6} y={y + 6} />
              </g>
            );
          })}
        </g>
      </ChartCanvas>
    </ChartFrame>
  );
}

export default FlowchartChartView;
