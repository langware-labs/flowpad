import { elk, pathOf, wrap } from './chartGeometry';
import { isRecord, seqId } from './sequenceToMermaid';

/**
 * flowchart.json (a `chartit.flowchart` value): a decision flow kept to short questions and
 * outcomes. What answers a question is its `state`; what a reader needs but the flow does not
 * turn on is a `note` — both are shown beside the canvas, never drawn into it.
 */

export const FLOW_KINDS = ['start', 'question', 'outcome', 'step'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export interface FlowNode {
  id: string;
  kind: FlowKind;
  label: string;
  /** A question's answer source: the stored fact that decides it. */
  state?: string;
  note?: string;
  /** Another chart (by name): drawn as "Open ↗". */
  ref?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** The answer this exit stands for (`yes`, `no`, `help desk`). */
  label?: string;
}

export interface FlowchartValue {
  title?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Chart-level notes, about no one node. */
  notes: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const opt = (v: unknown): string | undefined => str(v) || undefined;

/** Never throws: an empty or malformed value renders as an empty chart. */
export function parseFlowchart(raw: string | null | undefined): FlowchartValue {
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  const root = isRecord(data) ? data : {};
  const nodes: FlowNode[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(root.nodes) ? root.nodes : []) {
    if (!isRecord(item)) continue;
    const id = str(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = FLOW_KINDS.includes(item.kind as FlowKind) ? (item.kind as FlowKind) : 'step';
    nodes.push({
      id,
      kind,
      label: str(item.label) || id,
      state: opt(item.state),
      note: opt(item.note),
      ref: opt(item.ref),
    });
  }
  const edges: FlowEdge[] = [];
  for (const item of Array.isArray(root.edges) ? root.edges : []) {
    if (!isRecord(item)) continue;
    const from = str(item.from);
    const to = str(item.to);
    if (seen.has(from) && seen.has(to) && from !== to) edges.push({ from, to, label: opt(item.label) });
  }
  const notes = (Array.isArray(root.notes) ? root.notes : []).map(str).filter(Boolean);
  return { title: opt(root.title), nodes, edges, notes };
}

/** The number each question carries, in file order — what links it to its State row. */
export function questionNumbers(value: FlowchartValue): Map<string, string> {
  const out = new Map<string, string>();
  value.nodes.filter((n) => n.kind === 'question').forEach((n, i) => out.set(n.id, String(i + 1)));
  return out;
}

export const FLOW_NODE = { W: 240, LINE: 21, PAD: 16, CHARS: 25, PILL_H: 26 };
/** A diamond holds less text than its box: it is wider and its lines shorter. */
const QUESTION = { W: 290, CHARS: 20, PAD: 44 };
const LABEL_CHAR_W = 7.2;

export interface FlowBox {
  node: FlowNode;
  n?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  /** Room kept under the text for the Open ↗ pill. */
  pill: number;
}

export interface FlowLine {
  edge: FlowEdge;
  key: string;
  d: string;
  lx: number;
  ly: number;
  lw: number;
}

export interface FlowLayout {
  boxes: FlowBox[];
  lines: FlowLine[];
  boxOf: Map<string, FlowBox>;
  questions: number;
  width: number;
  height: number;
}

function sizeOf(node: FlowNode): { w: number; h: number; lines: string[]; pill: number } {
  const question = node.kind === 'question';
  const lines = wrap(node.label, question ? QUESTION.CHARS : FLOW_NODE.CHARS, 3);
  const text = Math.max(1, lines.length) * FLOW_NODE.LINE;
  const pill = node.ref ? FLOW_NODE.PILL_H + 8 : 0;
  return question
    ? { w: QUESTION.W, h: text + QUESTION.PAD * 2, lines, pill: 0 }
    : { w: FLOW_NODE.W, h: text + FLOW_NODE.PAD * 2 + pill, lines, pill };
}

interface ElkOut {
  children?: { id: string; x?: number; y?: number }[];
  edges?: {
    id: string;
    sections?: { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }[];
    labels?: { x?: number; y?: number; width: number; height: number }[];
  }[];
  width?: number;
  height?: number;
}
type Pt = { x: number; y: number };

/** Top-down layered layout (ELK): the flow reads from the start at the top to the outcomes below. */
export async function layoutFlowchart(value: FlowchartValue): Promise<FlowLayout> {
  const numbers = questionNumbers(value);
  const sizes = new Map(value.nodes.map((n) => [n.id, sizeOf(n)]));
  const labelW = (e: FlowEdge) => (e.label ? e.label.length * LABEL_CHAR_W + 16 : 0);
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '32',
      'elk.layered.spacing.nodeNodeBetweenLayers': '52',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=32,left=32,bottom=32,right=32]',
    },
    children: value.nodes.map((n) => ({ id: n.id, width: sizes.get(n.id)!.w, height: sizes.get(n.id)!.h })),
    edges: value.edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
      labels: e.label ? [{ text: e.label, width: labelW(e), height: 22 }] : [],
    })),
  };
  const out = (await elk.layout(graph as never)) as unknown as ElkOut;
  const at = new Map((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  const boxes: FlowBox[] = value.nodes.map((node) => {
    const s = sizes.get(node.id)!;
    const p = at.get(node.id) ?? { x: 0, y: 0 };
    return { node, n: numbers.get(node.id), x: p.x, y: p.y, w: s.w, h: s.h, lines: s.lines, pill: s.pill };
  });
  const routed = new Map((out.edges ?? []).map((e) => [e.id, e]));
  const lines: FlowLine[] = value.edges.map((edge, i) => {
    const e = routed.get(`e${i}`);
    const sec = e?.sections?.[0];
    const pts = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint] : [];
    const lab = e?.labels?.[0];
    const mid = pts[Math.floor(pts.length / 2)] ?? { x: 0, y: 0 };
    return {
      edge,
      key: `e${i}`,
      d: pathOf(pts),
      lx: lab?.x !== undefined ? lab.x + lab.width / 2 : mid.x,
      ly: lab?.y !== undefined ? (lab.y ?? 0) + lab.height / 2 : mid.y,
      lw: labelW(edge),
    };
  });
  return {
    boxes,
    lines,
    boxOf: new Map(boxes.map((b) => [b.node.id, b])),
    questions: numbers.size,
    width: Math.max(1, out.width ?? 1),
    height: Math.max(1, out.height ?? 1),
  };
}

const mmText = (text: string) => text.replace(/["\n\r]+/g, ' ').replace(/[<>]/g, '').trim();

/** The chart as a mermaid `flowchart` — CHART.md's text copy. Notes and state follow as comments. */
export function flowchartToMermaid(value: FlowchartValue): string {
  const numbers = questionNumbers(value);
  const out = ['flowchart TD'];
  for (const n of value.nodes) {
    const label = mmText(numbers.has(n.id) ? `${numbers.get(n.id)} · ${n.label}` : n.label);
    const shape =
      n.kind === 'question' ? `{"${label}"}` : n.kind === 'start' ? `(["${label}"])` : `["${label}"]`;
    out.push(`  ${seqId(n.id)}${shape}`);
  }
  for (const e of value.edges) {
    out.push(`  ${seqId(e.from)} ${e.label ? `-- "${mmText(e.label)}" -->` : '-->'} ${seqId(e.to)}`);
  }
  for (const n of value.nodes) {
    if (n.state) out.push(`  %% state ${numbers.get(n.id) ?? n.id}: ${mmText(n.state)}`);
    if (n.note) out.push(`  %% note ${numbers.get(n.id) ?? n.id}: ${mmText(n.note)}`);
  }
  for (const note of value.notes) out.push(`  %% note: ${mmText(note)}`);
  return out.join('\n') + '\n';
}
