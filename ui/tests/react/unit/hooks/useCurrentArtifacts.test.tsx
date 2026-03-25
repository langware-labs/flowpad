import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCurrentArtifacts } from '@src/hooks/flow-hooks';
import { ContextEntitiesEnum, dataContext, FlowDataStream } from '@sdk';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../../utils/test-utils';

describe('useCurrentArtifacts hook', () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    // Reset data manager to ensure clean state between tests
    await unitTestSetup();

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  // Helper to create wrapper with router context
  const createWrapper = (processId: string) => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/flow/${processId}`]}>
          <Routes>
            <Route path="/flow/:processId" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    wrapper.displayName = 'TestWrapper';
    return wrapper;
  };

  // Helper to process XML and finalize stream immediately for testing
  const processXMLSync = (flow: FlowMock, xml: string) => {
    // Create a mock message stream so FlowData gets added to the stream
    const messageStream = new FlowDataStream({ id: 'test-message', name: 'Test Message' });
    (flow as any)._currentMessageStream = messageStream;
    (flow as any)._stream.addSubstream(messageStream);

    const chunks = xml.split('||');
    for (const chunk of chunks) {
      if (chunk.trim()) {
        flow.ingestXmlChunk(chunk);
      }
    }
    // Call endStream to finalize processing and trigger DATA_END events
    (flow as any)._streamProcessor?.endStream();

    // Clear the message stream
    (flow as any)._currentMessageStream = null;
  };

  it('should include streaming artifacts in the results', async () => {
    const mockFlow = new FlowMock({ title: 'Test Flow' });
    // Set required expansions to avoid API calls
    mockFlow.setExpansion('permissions');
    mockFlow.setExpansion('auth_scopes');
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, mockFlow.typeId);

    const wrapper = createWrapper(mockFlow.id);
    const { result } = renderHook(() => useCurrentArtifacts(), { wrapper });

    // Initial state - includes any database artifacts from useEntitiesQuery
    // (in this test environment, may be empty, but in production would contain DB artifacts)
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
      expect(Array.isArray(result.current.data)).toBe(true);
    });

    const initialCount = result.current.data.length;

    // Add streaming artifacts via Flow ARTIFACT event -> useCurrentArtifacts.add()
    processXMLSync(
      mockFlow,
      '<flow-state key="current_mode" data-type="object">{"mode":"Agent"}</flow-state>||<flow-result data-type="object">{"type": "artifact", "id": "11111111-1111-4111-8111-111111111111", "name": "Streaming File 1", "ref_type": "file", "path": "/streaming/file1.txt", "metadata": {"source": "streaming"}}</flow-result>||<flow-result data-type="object">{"type": "artifact", "id": "22222222-2222-4222-8222-222222222222", "name": "Streaming File 2", "ref_type": "file", "path": "/streaming/file2.txt", "metadata": {"source": "streaming"}}</flow-result>',
    );

    // Verify combined result includes streaming artifacts added to initial (DB) artifacts
    await waitFor(() => {
      // Should have exactly 2 MORE artifacts than initial count
      // (initial count = DB artifacts, +2 = streaming artifacts)
      expect(result.current.data.length).toBe(initialCount + 2);

      // Verify STREAMING artifacts are present (from Flow ARTIFACT events)
      const streamingArtifact1 = result.current.data.find((a) => a.id === '11111111-1111-4111-8111-111111111111');
      const streamingArtifact2 = result.current.data.find((a) => a.id === '22222222-2222-4222-8222-222222222222');

      expect(streamingArtifact1).toBeDefined();
      expect(streamingArtifact1?.name).toBe('Streaming File 1');
      expect(streamingArtifact1?.path).toBe('/streaming/file1.txt');

      expect(streamingArtifact2).toBeDefined();
      expect(streamingArtifact2?.name).toBe('Streaming File 2');
      expect(streamingArtifact2?.path).toBe('/streaming/file2.txt');
    });
  });

  it('should update when new streaming artifacts are added', async () => {
    const mockFlow = new FlowMock({ title: 'Test Flow' });
    // Set required expansions to avoid API calls
    mockFlow.setExpansion('permissions');
    mockFlow.setExpansion('auth_scopes');
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, mockFlow.typeId);

    const wrapper = createWrapper(mockFlow.id);
    const { result } = renderHook(() => useCurrentArtifacts(), { wrapper });

    // Initial state
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    const initialCount = result.current.data.length;

    // Add first streaming artifact
    processXMLSync(
      mockFlow,
      '<flow-state key="current_mode" data-type="object">{"mode":"Agent"}</flow-state>||<flow-result data-type="object">{"type": "artifact", "id": "33333333-3333-4333-8333-333333333333", "name": "Streaming File 1", "ref_type": "file", "path": "/streaming/file1.txt"}</flow-result>',
    );

    await waitFor(() => {
      expect(result.current.data.length).toBe(initialCount + 1);
      const artifact = result.current.data.find((a) => a.id === '33333333-3333-4333-8333-333333333333');
      expect(artifact).toBeDefined();
      expect(artifact?.name).toBe('Streaming File 1');
    });

    // Add second streaming artifact
    processXMLSync(
      mockFlow,
      '<flow-result data-type="object">{"type": "artifact", "id": "44444444-4444-4444-8444-444444444444", "name": "Streaming File 2", "ref_type": "file", "path": "/streaming/file2.txt"}</flow-result>',
    );

    await waitFor(() => {
      expect(result.current.data.length).toBe(initialCount + 2);
      const artifact = result.current.data.find((a) => a.id === '44444444-4444-4444-8444-444444444444');
      expect(artifact).toBeDefined();
      expect(artifact?.name).toBe('Streaming File 2');
    });
  });
});
