/**
 * chart.json (a `chartit.sequence` value) → mermaid `sequenceDiagram`.
 *
 * Paired with `sequence_to_mermaid` in `flow_sdk/assets/types/chart_mermaid.py`: both
 * write CHART.md's auto block, so the rules are the same — participant id as the
 * mermaid id with its label after `as`, `->>` for a call, `-->>` for a dashed reply,
 * and a sub-flow (`ref`) as a `Note over` its lanes followed by its dashed `returns`.
 */

export interface SequenceParticipant {
  id: string;
  label: string;
  /** A second, muted line under the label (a route, a service name). */
  sublabel?: string;
  /** An icon tag (IconSpec, e.g. `brands.sonos`, `lucide.database`) drawn on the card. */
  icon?: string;
  note?: string;
}

export interface SequenceMessage {
  id: string;
  from: string;
  to: string;
  label: string;
  style?: string;
  note?: string;
  /** A sub-flow block: the name of another chart in the same project. */
  ref?: string;
  /** A sub-flow's output, drawn as a dashed arrow from `to` back into `from`. */
  returns?: string;
}

export interface SequenceValue {
  title?: string;
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
}

const HEADER = 'sequenceDiagram';
const INDENT = '  ';
// Python's str.splitlines() boundaries (it splits on the \x1c-\x1e separators too).
// eslint-disable-next-line no-control-regex
const LINE_SPLIT = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');

function seqText(value: unknown, lineBreak = ' '): string {
  const text = String(value)
    .split(LINE_SPLIT)
    .filter((line) => line.trim())
    .map((line) => line.split(/\s+/).filter(Boolean).join(' '))
    .join(lineBreak);
  return text.replaceAll(';', ',').replaceAll('#', '');
}

function seqId(value: unknown): string {
  return Array.from(String(value), (ch) => (/[\p{L}\p{N}_]/u.test(ch) ? ch : '_')).join('');
}

const scalar = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A participant's card lines: the label's first line, then an explicit sublabel or the legacy "label\nsecond" line. */
function participantLines(part: Record<string, unknown>): { label: string; sublabel?: string } {
  const [label = '', second] = (scalar(part.label) || scalar(part.id)).split('\n');
  return { label, sublabel: optStr(part.sublabel) || optStr(second) };
}

/** Never throws: an empty or malformed value renders as an empty diagram. */
export function sequenceToMermaid(data: unknown): string {
  const empty = `${HEADER}\n${INDENT}%% empty chart\n`;
  if (!isRecord(data)) return empty;
  const participants = Array.isArray(data.participants) ? data.participants.filter(isRecord) : [];
  const messages = Array.isArray(data.messages) ? data.messages.filter(isRecord) : [];
  if (!participants.length && !messages.length) return empty;

  const lines: string[] = [];
  for (const part of participants) {
    const pid = seqId(part.id ?? '');
    if (!pid) continue;
    const { label, sublabel } = participantLines(part);
    lines.push(`participant ${pid} as ${seqText([label, sublabel].filter(Boolean).join('\n'), '<br/>')}`);
    if (part.note) lines.push(`Note over ${pid}: ${seqText(part.note)}`);
  }
  for (const msg of messages) {
    const src = seqId(msg.from ?? '');
    const dst = seqId(msg.to ?? '') || src;
    if (!src) continue;
    const label = seqText(msg.label ?? '');
    if (msg.ref) {
      const span = src === dst ? src : `${src},${dst}`;
      lines.push(`Note over ${span}: ↗ ${label} (chart ${seqText(msg.ref)})`);
      if (msg.returns) lines.push(`${dst}-->>${src}: ${seqText(msg.returns)}`);
    } else {
      const arrow = msg.style === 'dashed' ? '-->>' : '->>';
      lines.push(`${src}${arrow}${dst}: ${label}`);
    }
    if (msg.note) lines.push(`Note right of ${dst}: ${seqText(msg.note)}`);
  }
  return `${HEADER}\n` + lines.map((line) => `${INDENT}${line}\n`).join('');
}

/** chart.json as the view draws it: anything unreadable becomes an empty sequence. */
export function parseSequence(raw: string | null): SequenceValue {
  if (!raw) return { participants: [], messages: [] };
  const parsed: unknown = JSON.parse(raw);
  // Accept the bare sequence value, or a chartit.chart row's input that nests it under `sequence`.
  const value = isRecord(parsed) && isRecord(parsed.sequence) ? { ...parsed.sequence, title: parsed.title } : parsed;
  if (!isRecord(value)) return { participants: [], messages: [] };
  return {
    title: typeof value.title === 'string' ? value.title : undefined,
    participants: (Array.isArray(value.participants) ? value.participants.filter(isRecord) : []).map((p) => ({
      id: scalar(p.id),
      ...participantLines(p),
      icon: optStr(p.icon),
      note: optStr(p.note),
    })),
    messages: (Array.isArray(value.messages) ? value.messages.filter(isRecord) : []) as unknown as SequenceMessage[],
  };
}
