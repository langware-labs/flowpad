/**
 * Tests for useProcessStreamingArtifacts hook
 */

import { FlowDataStream } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProcessStreamingArtifacts } from '@src/hooks/flow-hooks';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../../utils/test-utils';

describe('useProcessStreamingArtifacts hook', () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    await unitTestSetup();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  const createWrapper = () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    wrapper.displayName = 'TestWrapper';
    return wrapper;
  };

  // Helper to process XML and finalize stream for testing
  const processXMLSync = (flow: FlowMock, xml: string) => {
    const messageStream = new FlowDataStream({ id: 'test-message', name: 'Test Message' });
    (flow as any)._currentMessageStream = messageStream;
    (flow as any)._stream.addSubstream(messageStream);

    const chunks = xml.split('||');
    for (const chunk of chunks) {
      if (chunk.trim()) {
        flow.ingestXmlChunk(chunk);
      }
    }
    (flow as any)._streamProcessor?.endStream();
    (flow as any)._currentMessageStream = null;
  };

  it('should detect artifacts from completion stream and filter by timestamp', async () => {
    const mockFlow = new FlowMock({ title: 'Test Flow' });
    mockFlow.setExpansion('permissions');
    mockFlow.setExpansion('auth_scopes');

    const wrapper = createWrapper();
    const { result } = renderHook(() => useProcessStreamingArtifacts(mockFlow), { wrapper });

    // Initial state - no artifacts
    expect(result.current.artifacts).toEqual([]);

    // Stream artifacts with data-type="object" (completion stream format)
    processXMLSync(
      mockFlow,
      '<flow-result i="1" t="1000" data-type="object">{"type": "artifact", "id": "11111111-1111-4111-8111-111111111111", "name": "old.ts", "ref_type": "FILE", "path": "src/old.ts"}</flow-result>||' +
        '<flow-result i="2" t="3000" data-type="object">{"type": "artifact", "id": "22222222-2222-4222-8222-222222222222", "name": "new.ts", "ref_type": "FILE", "path": "src/new.ts"}</flow-result>',
    );

    // Verify artifacts are detected from plain objects
    await waitFor(() => {
      expect(result.current.artifacts.length).toBe(2);
      expect(result.current.artifactPaths).toContain('src/old.ts');
      expect(result.current.artifactPaths).toContain('src/new.ts');
    });

    // Verify getStreamingFlowDataAfter filters by timestamp correctly
    const afterTimestamp = result.current.getStreamingFlowDataAfter(2000);
    expect(afterTimestamp.length).toBe(1);
    expect(afterTimestamp[0].data.path).toBe('src/new.ts');
  });
});
