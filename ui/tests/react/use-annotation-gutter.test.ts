import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Controllable mock for useEntitiesQuery — lets us push new data mid-test
const useEntitiesQueryMock = vi.fn(() => ({ data: [], refetch: vi.fn() }));

vi.mock('@sdk/react/hooks', () => ({
  useEntitiesQuery: (...args: any[]) => useEntitiesQueryMock(...args),
}));

import { useAnnotationGutter } from '@src/components/terminal/interactive-terminal/use-annotation-gutter';

const mockAdapter = {
  getScrollState: () => ({ baseY: 0, cursorY: 10 }),
  getEvictionOffset: () => 0,
  getBufferLength: () => 0,
  getLineText: () => null,
} as any;

/** Helper: create a mock adapter backed by a mutable Map of lines. */
function makeAdapter(lines: Map<number, string>) {
  return {
    getEvictionOffset: () => 0,
    getBufferLength: () => lines.size,
    getLineText: (row: number) => lines.get(row) ?? null,
  } as any;
}

/** Helper: configure useEntitiesQueryMock to return given annotations. */
function mockAnnotations(data: any[]) {
  useEntitiesQueryMock.mockImplementation((req: any) => {
    if (req?.type === 'annotation') return { data, refetch: vi.fn() };
    return { data: [], refetch: vi.fn() };
  });
}

describe('useAnnotationGutter', () => {
  beforeEach(() => {
    useEntitiesQueryMock.mockReset();
    useEntitiesQueryMock.mockReturnValue({ data: [], refetch: vi.fn() });
  });

  it('returns empty elements when no adapter', () => {
    const { result } = renderHook(() =>
      useAnnotationGutter('sess-1', true, null),
    );
    expect(result.current.elements).toEqual([]);
  });

  it('returns empty elements when no workerSessionId', () => {
    const { result } = renderHook(() =>
      useAnnotationGutter(null, true, mockAdapter),
    );
    expect(result.current.elements).toEqual([]);
  });

  it('returns empty elements when terminalReady is false', () => {
    const { result } = renderHook(() =>
      useAnnotationGutter('sess-1', false, mockAdapter),
    );
    expect(result.current.elements).toEqual([]);
  });

  it('exposes createBookmark, createComment, deleteBookmark callbacks', () => {
    const { result } = renderHook(() =>
      useAnnotationGutter('sess-1', true, mockAdapter),
    );
    expect(typeof result.current.createBookmark).toBe('function');
    expect(typeof result.current.createComment).toBe('function');
    expect(typeof result.current.deleteBookmark).toBe('function');
  });

  describe('annotation positioning and reactivity', () => {
    it('resolves plan annotation after bufferVersion bumps (text arrives later)', () => {
      const lines = new Map<number, string>();
      lines.set(0, '$ /plan create a plan');
      const adapter = makeAdapter(lines);

      let annotationData: any[] = [];
      mockAnnotations(annotationData);
      // Need to re-mock since mockAnnotations captures the initial empty array
      useEntitiesQueryMock.mockImplementation((req: any) => {
        if (req?.type === 'annotation') return { data: annotationData, refetch: vi.fn() };
        return { data: [], refetch: vi.fn() };
      });

      let bufferVersion = 1;
      const { result, rerender } = renderHook(
        ({ version }) => useAnnotationGutter('sess-1', true, adapter, undefined, true, version),
        { initialProps: { version: bufferVersion } },
      );

      expect(result.current.elements).toEqual([]);

      // ── Annotation arrives, text NOT in buffer yet ──
      annotationData = [{
        id: 'ann-1',
        labels: ['plan:'],
        session_id: 'sess-1',
        content: '# Hello World Plan',
        data: { file_path: '/plans/hello.md' },
        created_date: '2026-03-15T00:00:00Z',
      }];
      rerender({ version: bufferVersion });

      // Text not in buffer → annotation not resolved
      expect(result.current.elements).toEqual([]);

      // ── PTY chunk arrives → buffer now has the text, version bumps ──
      lines.set(1, '❯ Hello World Plan');
      bufferVersion = 2;
      rerender({ version: bufferVersion });

      // Matched via stripped heading: "# Hello World Plan" → "Hello World Plan"
      expect(result.current.elements).toHaveLength(1);
      expect(result.current.elements[0]).toMatchObject({
        kind: 'plan',
        absRow: 1,
        annotation: expect.objectContaining({ id: 'ann-1' }),
      });
    });

    it('strips markdown heading markers to match terminal rendering', () => {
      const lines = new Map<number, string>();
      lines.set(0, '$ /plan create a plan');
      lines.set(1, 'Here is Claude\'s plan:');
      lines.set(2, '❯ Hello World Plan');
      lines.set(3, '');
      lines.set(4, 'Context');
      const adapter = makeAdapter(lines);

      // Backend stores "# Hello World Plan\n\nContext\n..." but terminal
      // renders the heading without the `#` prefix.
      mockAnnotations([{
        id: 'ann-md',
        labels: ['plan:'],
        session_id: 'sess-1',
        content: '# Hello World Plan\n\nContext\nCreate a simple hello',
        data: { file_path: '/plans/hello.md' },
        created_date: '2026-03-15T00:00:00Z',
      }]);

      const { result } = renderHook(() =>
        useAnnotationGutter('sess-1', true, adapter, undefined, true, 1),
      );

      expect(result.current.elements).toHaveLength(1);
      expect(result.current.elements[0]).toMatchObject({
        kind: 'plan',
        absRow: 2, // matches "Hello World Plan" (stripped heading)
      });
    });

    it('matches original first line when it appears verbatim in buffer', () => {
      const lines = new Map<number, string>();
      lines.set(0, '$ /plan');
      lines.set(1, '❯ # My Test Plan');
      const adapter = makeAdapter(lines);

      // First line "# My Test Plan" appears verbatim (e.g. raw markdown in buffer)
      mockAnnotations([{
        id: 'ann-verbatim',
        labels: ['plan:'],
        session_id: 'sess-1',
        content: '# My Test Plan\n\n1. Do something\n2. Do another thin',
        data: { file_path: '/plans/test.md' },
        created_date: '2026-03-15T00:00:00Z',
      }]);

      const { result } = renderHook(() =>
        useAnnotationGutter('sess-1', true, adapter, undefined, true, 1),
      );

      expect(result.current.elements).toHaveLength(1);
      expect(result.current.elements[0]).toMatchObject({ kind: 'plan', absRow: 1 });
    });

    it('resolves prompt annotation whose content has newlines (first line match)', () => {
      const lines = new Map<number, string>();
      lines.set(0, '$ prompt');
      lines.set(1, '❯ Please update the authentication');
      lines.set(2, 'to use the new API endpoints');
      const adapter = makeAdapter(lines);

      mockAnnotations([{
        id: 'ann-nl',
        labels: ['prompt:'],
        session_id: 'sess-1',
        content: 'Please update the authentication\nto use the new API endpoints',
        data: {},
        created_date: '2026-03-15T00:00:00Z',
      }]);

      const { result } = renderHook(() =>
        useAnnotationGutter('sess-1', true, adapter, undefined, true, 1),
      );

      expect(result.current.elements).toHaveLength(1);
      expect(result.current.elements[0]).toMatchObject({ kind: 'prompt', absRow: 1 });
    });

    it('skips annotation when content cannot be found in buffer (no fallback)', () => {
      const lines = new Map<number, string>();
      lines.set(0, '$ /plan');
      lines.set(1, 'Some unrelated output');
      const adapter = makeAdapter(lines);

      // "Plan created" doesn't appear in buffer → skipped
      mockAnnotations([{
        id: 'ann-skip',
        labels: ['plan:'],
        session_id: 'sess-1',
        content: 'Plan created',
        data: { file_path: '/plans/hello.md' },
        created_date: '2026-03-15T00:00:00Z',
      }]);

      const { result } = renderHook(() =>
        useAnnotationGutter('sess-1', true, adapter, undefined, true, 1),
      );

      expect(result.current.elements).toEqual([]);
    });
  });
});
