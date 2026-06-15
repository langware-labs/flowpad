import { describe, expect, it } from 'vitest';
import { deriveAnalysisAction } from '@src/components/lens-viewer/shared/transcript-features/analysis-state';

function trace(createdIso: string) {
  return { created_date: new Date(createdIso) } as any;
}

// isBusy(p) keys off status/worker_status — a RUNNING worker is busy.
function busyProcess() {
  return { status: 'running', worker_status: 'thinking' } as any;
}
function doneProcess() {
  return { status: 'complete', worker_status: 'complete' } as any;
}

describe('deriveAnalysisAction', () => {
  it('run: no traces, nothing running', () => {
    const a = deriveAnalysisAction({ traces: [], analysisProcesses: [], lastEntryTs: '2026-06-12T10:00:00Z' });
    expect(a.kind).toBe('run');
  });

  it('analyzing: a busy analysis process wins over existing traces', () => {
    const a = deriveAnalysisAction({
      traces: [trace('2026-06-12T09:00:00Z')],
      analysisProcesses: [doneProcess(), busyProcess()],
      lastEntryTs: '2026-06-12T10:00:00Z',
    });
    expect(a.kind).toBe('analyzing');
  });

  it('open: newest trace is fresher than the last transcript entry', () => {
    const a = deriveAnalysisAction({
      traces: [trace('2026-06-12T09:00:00Z'), trace('2026-06-12T11:00:00Z')],
      analysisProcesses: [doneProcess()],
      lastEntryTs: '2026-06-12T10:00:00Z',
    });
    expect(a.kind).toBe('open');
    if (a.kind === 'open') {
      expect(a.runCount).toBe(2);
      expect(a.trace.created_date?.toISOString()).toBe('2026-06-12T11:00:00.000Z');
    }
  });

  it('refresh: session has entries newer than the newest trace', () => {
    const a = deriveAnalysisAction({
      traces: [trace('2026-06-12T09:00:00Z')],
      analysisProcesses: [],
      lastEntryTs: '2026-06-12T10:00:00Z',
    });
    expect(a.kind).toBe('refresh');
    if (a.kind === 'refresh') expect(a.runCount).toBe(1);
  });

  it('open (not stale) when the last entry timestamp is unknown', () => {
    const a = deriveAnalysisAction({
      traces: [trace('2026-06-12T09:00:00Z')],
      analysisProcesses: [],
      lastEntryTs: null,
    });
    expect(a.kind).toBe('open');
  });
});
