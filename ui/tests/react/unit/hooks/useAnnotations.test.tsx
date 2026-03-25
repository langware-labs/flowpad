import { Annotation, TypeId } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnotations } from '@src/hooks/use-annotations';
import { unitTestSetup } from '../../../utils/test-utils';

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk/react/hooks')>();
  return {
    ...actual,
    useEntitiesQuery: vi.fn(),
  };
});

const mockUseEntitiesQuery = vi.mocked(useEntitiesQuery);

const makeQueryResult = (data: Annotation[] | undefined = [], overrides = {}) => ({
  data,
  isLoading: false,
  error: null,
  isError: false,
  isSuccess: true,
  refetch: vi.fn(),
  ...overrides,
});

const PROCESS_TYPE = 'agentic_process';
const PROCESS_ID   = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_ID     = '550e8400-e29b-41d4-a716-446655440099';

function makeAnnotation(overrides: Partial<ConstructorParameters<typeof Annotation>[0]> = {}) {
  return new Annotation({
    id: '550e8400-e29b-41d4-a716-44665544' + Math.random().toString().slice(2, 6),
    target_type: PROCESS_TYPE,
    target_id: PROCESS_ID,
    content: 'hello',
    labels: ['prompt:'],
    ...overrides,
  });
}

describe('useAnnotations hook', () => {
  beforeEach(async () => {
    await unitTestSetup();
    vi.clearAllMocks();
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult());
  });

  it('always enables the query regardless of typeId', () => {
    renderHook(() => useAnnotations(null));
    // The query is always enabled (no `enabled: false`)
    expect(mockUseEntitiesQuery).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'annotation' }),
    );
  });

  it('queries for annotation type', () => {
    renderHook(() => useAnnotations(null));
    const [req] = mockUseEntitiesQuery.mock.calls[0];
    expect(req.type).toBe('annotation');
  });

  it('returns all annotations when typeId is null', () => {
    const all = [makeAnnotation(), makeAnnotation({ target_id: OTHER_ID })];
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult(all));

    const { result } = renderHook(() => useAnnotations(null));
    expect(result.current.annotations).toHaveLength(2);
  });

  it('filters client-side by target_type and target_id when typeId is provided', () => {
    const match   = makeAnnotation({ target_type: PROCESS_TYPE, target_id: PROCESS_ID });
    const noMatch = makeAnnotation({ target_type: PROCESS_TYPE, target_id: OTHER_ID });
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult([match, noMatch]));

    const typeId = new TypeId(PROCESS_TYPE, PROCESS_ID);
    const { result } = renderHook(() => useAnnotations(typeId));

    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.annotations[0].target_id).toBe(PROCESS_ID);
  });

  it('returns empty array when no annotations match the typeId', () => {
    const noMatch = makeAnnotation({ target_id: OTHER_ID });
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult([noMatch]));

    const typeId = new TypeId(PROCESS_TYPE, PROCESS_ID);
    const { result } = renderHook(() => useAnnotations(typeId));

    expect(result.current.annotations).toHaveLength(0);
  });

  it('reflects loading state', () => {
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult(undefined, { isLoading: true, isSuccess: false }));
    const { result } = renderHook(() => useAnnotations(null));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.annotations).toEqual([]);
  });

  it('reflects error state', () => {
    const err = new Error('fetch failed') as any;
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult(undefined, { error: err, isError: true, isSuccess: false }));
    const { result } = renderHook(() => useAnnotations(null));
    expect(result.current.error).toBe(err);
    expect(result.current.annotations).toEqual([]);
  });

  it('exposes a refetch function', () => {
    const refetchMock = vi.fn();
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult([], { refetch: refetchMock }));
    const { result } = renderHook(() => useAnnotations(null));
    result.current.refetch();
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a single shared QueryRequest (module-level constant)', () => {
    const typeId = new TypeId(PROCESS_TYPE, PROCESS_ID);
    const { rerender } = renderHook(() => useAnnotations(typeId));
    rerender();
    const call1 = mockUseEntitiesQuery.mock.calls[0][0];
    const call2 = mockUseEntitiesQuery.mock.calls[1][0];
    expect(call1).toBe(call2);
  });

  it('returns multiple matching annotations', () => {
    const a1 = makeAnnotation({ content: 'first' });
    const a2 = makeAnnotation({ content: 'second' });
    const other = makeAnnotation({ target_id: OTHER_ID });
    mockUseEntitiesQuery.mockReturnValue(makeQueryResult([a1, a2, other]));

    const typeId = new TypeId(PROCESS_TYPE, PROCESS_ID);
    const { result } = renderHook(() => useAnnotations(typeId));

    expect(result.current.annotations).toHaveLength(2);
  });
});
