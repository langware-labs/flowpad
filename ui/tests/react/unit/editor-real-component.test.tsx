/**
 * Editor Progressive Write Test - Real Component
 *
 * Tests that flow-write streaming chunks progressively accumulate content in the REAL CodeEditor component,
 * validating the full integration from flow-write chunks -> FSStore -> Editor UI rendering.
 */

// Mock Monaco Editor BEFORE any imports to prevent React instance mismatch errors
import React from 'react';
import { vi } from 'vitest';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, path }: { value?: string; path?: string }) => (
    <div data-testid="monaco-editor-mock" data-path={path}>
      {value || ''}
    </div>
  ),
}));

import { Agent, Flow, fsStore } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

// Import the real CodeEditor component
// CodeEditor uses default export
import CodeEditor from '@src/components/code-editor/CodeEditor';

// Agent context interface (matches real AgentContext)
interface AgentContext {
  agent: Agent | null | undefined;
  flow: Flow | null | undefined;
  computeNode: any;
}

// Wrapper to provide agent context via Outlet
function AgentContextProvider({ context }: { context: AgentContext }) {
  return <Outlet context={context} />;
}

describe('CodeEditor - Progressive Write with Real Component', () => {
  let queryClient: QueryClient;
  let flowMock: FlowMock;
  const agentId = 'agent-test-123';
  const processId = '550e8400-e29b-41d4-a716-446655440300';

  beforeEach(async () => {
    await unitTestSetup();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    flowMock = new FlowMock({ id: processId });
    flowMock.streamChunkDelay = 10;
  });

  afterEach(async () => {
    // Clean up React components to prevent Monaco Editor async initialization errors
    cleanup();
    // Wait a bit for Monaco Editor to finish any pending operations
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('should render editor and show progressive file content accumulation', async () => {
    // Mock XML with 3 short flow-write chunks and breakpoints
    const mockXML =
      '<flow-user-message i="1" t="2025-10-28T13:28:25.978721+00:00" data-type="string">write file</flow-user-message>' +
      // First chunk - "Hello"
      '<flow-write i="2" t="2025-10-28T13:28:40.283966+00:00" focus="editor" data-type="string" path="story.txt">Hello</flow-write>' +
      '||' +
      '|break|' + // BREAKPOINT 1
      '<flow-write i="3" t="2025-10-28T13:28:40.304518+00:00" focus="editor" data-type="string" path="story.txt"> World</flow-write>' +
      '||' +
      '|break|' + // BREAKPOINT 2
      // Third chunk - "!"
      '<flow-write i="4" t="2025-10-28T13:28:40.385806+00:00" focus="editor" data-type="string" path="story.txt">!</flow-write>';

    flowMock.setMockStreamXML(mockXML);

    // Render the REAL CodeEditor with all required providers
    const agentContext: AgentContext = {
      agent: null,
      flow: flowMock,
      computeNode: null,
    };

    render(
      <MemoryRouter initialEntries={[`/agent/${agentId}/flow/${processId}`]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route element={<AgentContextProvider context={agentContext} />}>
              <Route path="/agent/:agentId/flow/:processId" element={<CodeEditor activePath="story.txt" />} />
            </Route>
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Start streaming (fire and forget - we'll wait for breakpoints)
    void flowMock.sendMessage('write file');

    // Wait for first breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Verify content after first chunk: "Hello"
    await waitFor(
      () => {
        const cached = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
        expect(cached).toBeTruthy();
        expect(cached?.content).toBe('Hello');
      },
      { timeout: 2000 },
    );

    // Verify ONLY the first chunk is accumulated (NOT the second chunk yet)
    const contentAtBreak1 = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
    expect(contentAtBreak1?.content).toBe('Hello');
    expect(contentAtBreak1?.content).not.toContain('World');

    // Continue streaming to second breakpoint
    await flowMock.continueStreaming();
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Verify content after second chunk: "Hello World"
    await waitFor(
      () => {
        const cached = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
        expect(cached).toBeTruthy();
        expect(cached?.content).toBe('Hello World');
      },
      { timeout: 2000 },
    );

    // Verify the first chunk is still there and second chunk is accumulated
    const contentAtBreak2 = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
    expect(contentAtBreak2?.content).toContain('Hello');
    expect(contentAtBreak2?.content).toContain('World');
    expect(contentAtBreak2?.content).not.toContain('!'); // Third chunk not yet

    // Continue streaming to completion
    await flowMock.continueStreaming();
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

    // Verify final content: "Hello World!"
    await waitFor(
      () => {
        const cached = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
        expect(cached).toBeTruthy();
        expect(cached?.content).toBe('Hello World!');
      },
      { timeout: 2000 },
    );

    // Verify all chunks are accumulated
    const finalContent = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
    expect(finalContent?.content).toBe('Hello World!');
    expect(flowMock.isAtBreakpoint()).toBe(false);
  });
});
