import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessKind, QueryRequest } from '@sdk';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';

const mocks = vi.hoisted(() => ({ useEntitiesQuery: vi.fn() }));

vi.mock('@sdk/react/hooks', () => ({
  useEntitiesQuery: (...args: unknown[]) => mocks.useEntitiesQuery(...args),
}));

beforeEach(() => {
  mocks.useEntitiesQuery.mockReset();
  mocks.useEntitiesQuery.mockReturnValue({ data: [], isLoading: false, error: null });
});

describe('useProcessesForTarget deployment scope', () => {
  it('adds the selected deployment to both the server filter and cache identity', () => {
    renderHook(() =>
      useProcessesForTarget('agent-00000000-0000-4000-8000-000000000001', {
        processType: ProcessKind.Chat,
        deploymentId: '00000000-0000-4000-8000-000000000002',
      }),
    );

    const request = mocks.useEntitiesQuery.mock.calls[0]?.[0] as QueryRequest;
    expect(request.name).toContain('00000000-0000-4000-8000-000000000002');
    expect(request.queryKey).toContain('agent-00000000-0000-4000-8000-000000000001');
    expect(request.queryKey).toContain(ProcessKind.Chat);
    expect(request.queryKey).toContain('00000000-0000-4000-8000-000000000002');
  });
});
