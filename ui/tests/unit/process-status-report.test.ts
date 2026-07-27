import { describe, it, expect } from 'vitest';
import { AgenticProcess, ProcessCounters, parseStatusReport } from '@sdk';
import { FlowData } from '@sdk/flow_processing';

/**
 * Frontend mirror of the ProcessStatusReport projection. The exact integers
 * here match the backend fixture totals asserted in
 * tests/unit/test_transcript_analyzer/test_process_counters.py — this proves
 * the wire round-trip carries the numbers unchanged (laser-accurate parity).
 */

const CLAUDE_COUNTERS = {
  input_tokens: 8,
  output_tokens: 4331,
  cache_read_tokens: 215526,
  cache_write_tokens: 3941,
  assistant_messages: 3,
  tool_calls: 1,
};

function report(counters = CLAUDE_COUNTERS, extra = {}) {
  return {
    counters,
    focused_asset: { asset_type: 'markdown', ref_type: 'vfs', ref_value: '/tmp/hello.md' },
    worker_status: 'thinking',
    process_status: 'running',
    ...extra,
  };
}

describe('ProcessCounters', () => {
  it('sums the four disjoint token dims exactly', () => {
    const c = ProcessCounters.from(CLAUDE_COUNTERS);
    expect(c.totalTokens).toBe(8 + 4331 + 215526 + 3941);
    expect(c.output_tokens).toBe(4331);
  });

  it('formats a compact one-liner', () => {
    const c = ProcessCounters.from(CLAUDE_COUNTERS);
    // total = 223806 → "224k" (≥10k rounds to whole k); 3 assistant messages
    expect(c.formatted()).toBe('224k tok · 3 msgs');
    expect(ProcessCounters.from({ ...CLAUDE_COUNTERS, assistant_messages: 1 }).formatted())
      .toMatch(/· 1 msg$/);
  });

  it('defaults every counter to 0', () => {
    const c = ProcessCounters.from(null);
    expect(c.totalTokens).toBe(0);
    expect(c.tool_calls).toBe(0);
  });
});

describe('parseStatusReport', () => {
  it('parses an object and a JSON string identically', () => {
    const fromObj = parseStatusReport(report());
    const fromStr = parseStatusReport(JSON.stringify(report()));
    expect(fromObj?.counters.totalTokens).toBe(223806);
    expect(fromStr?.counters.totalTokens).toBe(223806);
    expect(fromObj?.focused_asset?.ref_value).toBe('/tmp/hello.md');
  });

  it('returns null for garbage / missing counters', () => {
    expect(parseStatusReport(null)).toBeNull();
    expect(parseStatusReport('not json')).toBeNull();
    expect(parseStatusReport({ worker_status: 'x' })).toBeNull();
  });
});

describe('AgenticProcess statusReport wiring', () => {
  it('mirrors the persisted status_report field on construction', () => {
    const proc = new AgenticProcess({ id: '11111111-1111-4111-8111-111111111111', status: 'running', status_report: report() });
    expect(proc.statusReport?.counters.output_tokens).toBe(4331);
    expect(proc.statusReport?.counters.totalTokens).toBe(223806);
    expect(proc.statusReport?.focused_asset?.asset_type).toBe('markdown');
  });

  it('updates statusReport from a live progress_report envelope, exactly', () => {
    const proc = new AgenticProcess({ id: '22222222-2222-4222-8222-222222222222', status: 'running' });
    expect(proc.statusReport).toBeNull();

    const events: unknown[] = [];
    proc.on('status_report', (r) => events.push(r));

    const fd = new FlowData('progress_report', JSON.stringify(report()), {
      kind: 'process_status',
      t: new Date(0).toISOString(),
    });
    proc.handleFlowData(fd);

    expect(proc.statusReport?.counters.cache_read_tokens).toBe(215526);
    expect(proc.statusReport?.counters.assistant_messages).toBe(3);
    expect(events).toHaveLength(1);
    // Control-plane report must NOT leak into the renderable flow stream.
    expect(proc.flowDataStream.items).toHaveLength(0);
  });

  it('leaves other FlowData flowing to the base handler', () => {
    const proc = new AgenticProcess({ id: '33333333-3333-4333-8333-333333333333', status: 'running' });
    const fd = new FlowData('chat', 'hello', { t: new Date(0).toISOString() });
    proc.handleFlowData(fd);
    expect(proc.flowDataStream.items.length).toBeGreaterThan(0);
  });
});
