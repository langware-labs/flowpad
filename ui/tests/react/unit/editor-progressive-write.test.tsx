/**
 * Editor Progressive Write Test
 *
 * Tests that flow-write streaming chunks progressively accumulate content in the editor's FSStore,
 * not all at once after streaming completes.
 *
 * This validates that each flow-write chunk appends to the file content incrementally.
 */

import { Flow, FlowElementTypes, fsStore } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

// Simple component that subscribes to flow changes (mimics editor behavior)
function SimpleEditorMonitor({ flow }: { flow: Flow }) {
  const [updateCount, setUpdateCount] = React.useState(0);

  React.useEffect(() => {
    const handleUpdate = () => {
      setUpdateCount((prev) => prev + 1);
    };

    // Subscribe to stream updates
    flow.on('data:end', handleUpdate);
    return () => {
      flow.off('data:end', handleUpdate);
    };
  }, [flow]);

  return <div data-testid="editor-monitor">Updates: {updateCount}</div>;
}

describe('Editor - Progressive Content Accumulation', () => {
  let queryClient: QueryClient;
  let flowMock: FlowMock;

  beforeEach(async () => {
    await unitTestSetup();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    flowMock = new FlowMock({ id: '550e8400-e29b-41d4-a716-446655440200' });

    flowMock.streamChunkDelay = 10; // Fast streaming for tests

    // Clear FSStore before each test
    fsStore.getState().clearCache();
  });

  it('should progressively accumulate flow-write chunks into story.txt', async () => {
    // Mock XML with 3 flow-write chunks and breakpoints
    // Based on the reference XML provided by the user
    const mockXML =
      '<flow-user-message i="385" t="2025-10-28T13:28:25.978721+00:00" data-type="string">write a short story to story.txt</flow-user-message>' +
      '<flow-state i="386" t="2025-10-28T13:28:33.317339+00:00" data-type="object" key="current_mode">{"mode": "Agent"}</flow-state>' +
      '<flow-chat i="416" t="2025-10-28T13:28:40.111903+00:00" data-type="string">I\'ll write a short story to story.txt for you.</flow-chat>' +
      // First write chunk - empty (creates the file)
      '<flow-write i="419" t="2025-10-28T13:28:40.282616+00:00" focus="editor" data-type="string" path="story.txt"></flow-write>' +
      '<flow-status i="420" t="2025-10-28T13:28:40.283357+00:00" data-type="string">Creating file...</flow-status>' +
      // Second write chunk - "The Last Library"
      '<flow-write i="421" t="2025-10-28T13:28:40.283966+00:00" focus="editor" data-type="string" path="story.txt">The</flow-write>' +
      '<flow-write i="422" t="2025-10-28T13:28:40.304518+00:00" focus="editor" data-type="string" path="story.txt"> Last Library</flow-write>' +
      '||' +
      '|break|' + // BREAKPOINT 1: Should have "The Last Library"
      // Third write chunk - first paragraph
      '<flow-write i="423" t="2025-10-28T13:28:40.385806+00:00" focus="editor" data-type="string" path="story.txt">\n\nIn a worl</flow-write>' +
      '<flow-write i="424" t="2025-10-28T13:28:40.429086+00:00" focus="editor" data-type="string" path="story.txt">d where books ha</flow-write>' +
      '<flow-write i="425" t="2025-10-28T13:28:40.454297+00:00" focus="editor" data-type="string" path="story.txt">d become</flow-write>' +
      '<flow-write i="426" t="2025-10-28T13:28:40.508428+00:00" focus="editor" data-type="string" path="story.txt"> memory</flow-write>' +
      '||' +
      '|break|' + // BREAKPOINT 2: Should have title + first sentence
      // Fourth write chunk - continue paragraph
      '<flow-write i="427" t="2025-10-28T13:28:40.589351+00:00" focus="editor" data-type="string" path="story.txt">, Elena</flow-write>' +
      '<flow-write i="428" t="2025-10-28T13:28:40.613042+00:00" focus="editor" data-type="string" path="story.txt"> walke</flow-write>' +
      '<flow-write i="429" t="2025-10-28T13:28:40.691025+00:00" focus="editor" data-type="string" path="story.txt">d through hol</flow-write>' +
      '<flow-write i="430" t="2025-10-28T13:28:40.767179+00:00" focus="editor" data-type="string" path="story.txt">ographic streets</flow-write>' +
      '<flow-write i="431" t="2025-10-28T13:28:40.789145+00:00" focus="editor" data-type="string" path="story.txt"> searching</flow-write>' +
      '<flow-write i="432" t="2025-10-28T13:28:40.872118+00:00" focus="editor" data-type="string" path="story.txt"> for something</flow-write>' +
      '<flow-write i="433" t="2025-10-28T13:28:40.916119+00:00" focus="editor" data-type="string" path="story.txt"> real.</flow-write>';

    flowMock.setMockStreamXML(mockXML);

    // Render monitor component
    render(
      <QueryClientProvider client={queryClient}>
        <SimpleEditorMonitor flow={flowMock} />
      </QueryClientProvider>,
    );

    // Start streaming
    const _sendPromise = flowMock.sendMessage('write a short story');

    // Wait for first breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Verify content after first chunk: "The Last Library"
    await waitFor(
      () => {
        const cached = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
        expect(cached).toBeTruthy();
        expect(cached?.content).toBe('The Last Library');
      },
      { timeout: 2000 },
    );

    // Verify ONLY the first chunk is accumulated (NOT the second chunk yet)
    const contentAtBreak1 = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
    expect(contentAtBreak1?.content).toBe('The Last Library');
    expect(contentAtBreak1?.content).not.toContain('In a worl');

    // Continue streaming to second breakpoint
    await flowMock.continueStreaming();

    // Wait for second breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Verify content after second chunk: title + first sentence
    await waitFor(
      () => {
        const cached = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
        expect(cached).toBeTruthy();
        expect(cached?.content).toBe('The Last Library\n\nIn a world where books had become memory');
      },
      { timeout: 2000 },
    );

    // Verify the first chunk is still there and second chunk is accumulated
    const contentAtBreak2 = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
    expect(contentAtBreak2?.content).toContain('The Last Library');
    expect(contentAtBreak2?.content).toContain('In a world where books had become memory');
    expect(contentAtBreak2?.content).not.toContain('Elena'); // Third chunk not yet

    // Continue streaming to completion
    await flowMock.continueStreaming();

    // Wait for streaming to complete
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

    // Verify final content: all chunks accumulated
    await waitFor(
      () => {
        const cached = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'story.txt');
        expect(cached).toBeTruthy();
        const expectedContent =
          'The Last Library\n\n' +
          'In a world where books had become memory, Elena walked through holographic streets searching for something real.';
        expect(cached?.content).toBe(expectedContent);
      },
      { timeout: 2000 },
    );

    // Verify all write elements are in the stream
    const writeElements = flowMock.stream.items.filter((item) => item.elementType === FlowElementTypes.WRITE);
    expect(writeElements.length).toBeGreaterThan(10); // Many flow-write chunks

    // Should no longer be at breakpoint
    expect(flowMock.isAtBreakpoint()).toBe(false);
  });

  it('should handle empty flow-write elements (file creation)', async () => {
    // Mock XML with empty flow-write followed by content
    const mockXML =
      '<flow-user-message i="1" t="2025-10-28T13:28:25.978721+00:00" data-type="string">create test.txt</flow-user-message>' +
      '<flow-write i="2" t="2025-10-28T13:28:40.282616+00:00" focus="editor" data-type="string" path="test.txt"></flow-write>' +
      '||' +
      '|break|' + // After empty write
      '<flow-write i="3" t="2025-10-28T13:28:40.283966+00:00" focus="editor" data-type="string" path="test.txt">Hello</flow-write>' +
      '<flow-write i="4" t="2025-10-28T13:28:40.304518+00:00" focus="editor" data-type="string" path="test.txt"> World</flow-write>';

    flowMock.setMockStreamXML(mockXML);

    render(
      <QueryClientProvider client={queryClient}>
        <SimpleEditorMonitor flow={flowMock} />
      </QueryClientProvider>,
    );

    const _sendPromise = flowMock.sendMessage('create test.txt');

    // Wait for first breakpoint (after empty write)
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Empty flow-write elements don't create FSStore entries (no content = no cache)
    // This is correct behavior - verify file doesn't exist in cache yet
    const cachedBeforeContent = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'test.txt');
    expect(cachedBeforeContent).toBeNull();

    // Continue streaming
    await flowMock.continueStreaming();

    // Wait for completion
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

    // Verify final content after non-empty writes
    const finalContent = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'test.txt');
    expect(finalContent?.content).toBe('Hello World');
  });

  it('should handle multiple files with separate accumulation', async () => {
    // Mock XML writing to two different files
    const mockXML =
      '<flow-write i="1" t="2025-10-28T13:28:40.282616+00:00" focus="editor" data-type="string" path="file1.txt">First</flow-write>' +
      '<flow-write i="2" t="2025-10-28T13:28:40.283966+00:00" focus="editor" data-type="string" path="file1.txt"> file</flow-write>' +
      '||' +
      '|break|' +
      '<flow-write i="3" t="2025-10-28T13:28:40.304518+00:00" focus="editor" data-type="string" path="file2.txt">Second</flow-write>' +
      '<flow-write i="4" t="2025-10-28T13:28:40.305518+00:00" focus="editor" data-type="string" path="file2.txt"> file</flow-write>';

    flowMock.setMockStreamXML(mockXML);

    render(
      <QueryClientProvider client={queryClient}>
        <SimpleEditorMonitor flow={flowMock} />
      </QueryClientProvider>,
    );

    const _sendPromise = flowMock.sendMessage('test');

    // Wait for breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Verify file1.txt has content
    const file1 = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'file1.txt');
    expect(file1?.content).toBe('First file');

    // Verify file2.txt doesn't exist yet
    const file2Before = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'file2.txt');
    expect(file2Before).toBeNull();

    // Continue streaming
    await flowMock.continueStreaming();

    // Wait for completion
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

    // Verify both files have correct content
    const file1Final = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'file1.txt');
    const file2Final = fsStore.getState().getContentFromCache(flowMock.projectTypeId!, 'file2.txt');
    expect(file1Final?.content).toBe('First file');
    expect(file2Final?.content).toBe('Second file');
  });
});
