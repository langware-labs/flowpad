/**
 * ProcessStatusReport — the frontend mirror of the backend projection
 * (`flow_sdk/transcript_analyzer/counters.py`). A running agentic process pushes
 * this snapshot on the `progress_report` flow_data envelope; it also rides the
 * persisted `status_report` field so the counters one-liner survives a reload.
 *
 * `ProcessCounters` is a class (not a bare interface) so counters can grow
 * methods without touching every call site — the "extend later" seam.
 */

/** What the process is currently pointing at, in the URL ref grammar. */
export interface FocusedAsset {
  /** Backend type — resolves its icon via `iconForType`, never hardcoded. */
  asset_type: string;
  /** Mirrors `AssetRoutingMethod`: `vfs` → abs VFS path; `typeid` → TypeId. */
  ref_type: 'vfs' | 'typeid';
  ref_value: string;
}

/**
 * The `attributes.kind` marking a `progress_report` FlowData as a process
 * status report. Mirror of `PROCESS_STATUS_KIND` in
 * `flow_sdk/transcript_analyzer/counters.py` — keep the two in sync.
 */
export const PROCESS_STATUS_KIND = 'process_status';

/** Plain wire shape of the counters (what the backend serializes). */
export interface ProcessCountersData {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  assistant_messages: number;
  tool_calls: number;
}

/** Running token / message / tool-call totals with display helpers. */
export class ProcessCounters implements ProcessCountersData {
  input_tokens = 0;
  output_tokens = 0;
  cache_read_tokens = 0;
  cache_write_tokens = 0;
  assistant_messages = 0;
  tool_calls = 0;

  constructor(data?: Partial<ProcessCountersData>) {
    if (data) Object.assign(this, data);
  }

  static from(data?: Partial<ProcessCountersData> | null): ProcessCounters {
    return new ProcessCounters(data ?? undefined);
  }

  /** All four token dims (they are disjoint, so summing is exact). */
  get totalTokens(): number {
    return (
      this.input_tokens +
      this.output_tokens +
      this.cache_read_tokens +
      this.cache_write_tokens
    );
  }

  /** Compact count, e.g. 12345 → "12.3k", 900 → "900". */
  private static compact(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  /** One-liner suffix, e.g. "12.3k tok · 4 msgs". */
  formatted(): string {
    const msgs = this.assistant_messages;
    return `${ProcessCounters.compact(this.totalTokens)} tok · ${msgs} msg${msgs === 1 ? '' : 's'}`;
  }
}

export interface ProcessStatusReport {
  counters: ProcessCounters;
  focused_asset: FocusedAsset | null;
  worker_status: string;
  /** Lifecycle FSM value (``running`` and all — no ready/busy projection). */
  process_status: string;
  /** Turn-in-flight, the orthogonal boolean axis. */
  busy: boolean;
}

/**
 * Parse a report off the wire (persisted `status_report` field OR the
 * `progress_report` flow_data payload). Returns null for absent/garbage input
 * so callers can `?? keep-previous`.
 */
export function parseStatusReport(raw: unknown): ProcessStatusReport | null {
  const obj = typeof raw === 'string' ? tryParse(raw) : raw;
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (!('counters' in r)) return null;
  const fa = r.focused_asset as FocusedAsset | null | undefined;
  return {
    counters: ProcessCounters.from(r.counters as Partial<ProcessCountersData>),
    focused_asset: fa && typeof fa === 'object' ? fa : null,
    worker_status: String(r.worker_status ?? ''),
    process_status: String(r.process_status ?? ''),
    busy: r.busy === true,
  };
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
