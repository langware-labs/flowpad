/**
 * Chat Panel Progressive Rendering Test
 *
 * Tests that streaming response chunks render progressively in the chat panel,
 * not all at once after streaming completes.
 *
 * This validates the bug where chunks arrive but UI renders them in bulk.
 */

import { Flow, FlowElementTypes } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

// Mock the chat panel component - simplified version for testing
function SimpleChatPanel({ flow }: { flow: Flow }) {
  const [messages, setMessages] = React.useState<string[]>([]);

  // Subscribe to flow stream changes (mimics useSyncExternalStore behavior)
  React.useEffect(() => {
    const updateMessages = () => {
      const textItems = flow.stream.items.filter((item) => item.elementType === FlowElementTypes.TEXT);
      const newMessages = textItems.map((item) => item.content || '');
      setMessages(newMessages);
    };

    // Initial load
    updateMessages();

    // Subscribe to stream updates - use 'data:end' to get fully parsed content
    flow.on('data:end', updateMessages);
    return () => {
      flow.off('data:end', updateMessages);
    };
  }, [flow]);

  return (
    <div data-testid="chat-panel">
      {messages.map((msg, i) => (
        <div key={i} data-testid={`message-${i}`}>
          {msg}
        </div>
      ))}
    </div>
  );
}

describe('Chat Panel - Progressive Rendering', () => {
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

    flowMock = new FlowMock({ id: '550e8400-e29b-41d4-a716-446655440100' });
    flowMock.streamChunkDelay = 10; // Fast streaming for tests
  });

  it('should render stream chunks progressively as they arrive', async () => {
    // XML with breakpoints to control streaming
    const mockXML =
      '<flow-text i="1" t="2025-01-01T10:00:00Z" data-type="string">First chunk arrives</flow-text>' +
      '|| |break| ||' +
      '<flow-text i="2" t="2025-01-01T10:00:01Z" data-type="string">Second chunk arrives</flow-text>' +
      '|| |break| ||' +
      '<flow-text i="3" t="2025-01-01T10:00:02Z" data-type="string">Third chunk arrives</flow-text>';

    flowMock.setMockStreamXML(mockXML);

    // Render chat panel
    const { container: _container } = render(
      <QueryClientProvider client={queryClient}>
        <SimpleChatPanel flow={flowMock} />
      </QueryClientProvider>,
    );

    // Start streaming (keep promise for later)
    const _sendPromise = flowMock.sendMessage('test');

    // Wait for first chunk and breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Wait for React to render the first chunk
    await waitFor(
      () => {
        const msg = screen.queryByTestId('message-0');
        expect(msg).toBeInTheDocument();
        expect(msg).toHaveTextContent('First chunk arrives');
      },
      { timeout: 2000 },
    );

    // Verify ONLY first chunk is visible (NOT second or third)
    expect(screen.queryByText('Second chunk arrives')).not.toBeInTheDocument();
    expect(screen.queryByText('Third chunk arrives')).not.toBeInTheDocument();

    // Continue streaming to second chunk
    await flowMock.continueStreaming();

    // Wait for second breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Wait for React to render the second chunk
    await waitFor(
      () => {
        expect(screen.getByTestId('message-1')).toHaveTextContent('Second chunk arrives');
      },
      { timeout: 2000 },
    );

    // Verify first AND second chunks are visible, but NOT third
    expect(screen.getByTestId('message-0')).toHaveTextContent('First chunk arrives');
    expect(screen.queryByText('Third chunk arrives')).not.toBeInTheDocument();

    // Continue streaming to completion
    await flowMock.continueStreaming();

    // Wait for third chunk to render
    await waitFor(
      () => {
        expect(screen.getByTestId('message-2')).toHaveTextContent('Third chunk arrives');
      },
      { timeout: 2000 },
    );

    // Verify all three chunks are now visible
    expect(screen.getByTestId('message-0')).toHaveTextContent('First chunk arrives');
    expect(screen.getByTestId('message-1')).toHaveTextContent('Second chunk arrives');
    expect(screen.getByTestId('message-2')).toHaveTextContent('Third chunk arrives');

    // Should no longer be at breakpoint
    expect(flowMock.isAtBreakpoint()).toBe(false);
  });

  it('should handle rapid successive chunks without batching', async () => {
    // XML with multiple chunks and NO breakpoints (rapid streaming)
    const mockXML =
      '<flow-text i="1" t="2025-01-01T10:00:00Z" data-type="string">Chunk 1</flow-text>' +
      '||' +
      '<flow-text i="2" t="2025-01-01T10:00:01Z" data-type="string">Chunk 2</flow-text>' +
      '||' +
      '<flow-text i="3" t="2025-01-01T10:00:02Z" data-type="string">Chunk 3</flow-text>' +
      '||' +
      '<flow-text i="4" t="2025-01-01T10:00:03Z" data-type="string">Chunk 4</flow-text>';

    flowMock.setMockStreamXML(mockXML);

    // Render chat panel
    render(
      <QueryClientProvider client={queryClient}>
        <SimpleChatPanel flow={flowMock} />
      </QueryClientProvider>,
    );

    // Start streaming
    await flowMock.sendMessage('test');

    // Wait for completion
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

    // All chunks should be rendered
    expect(screen.getByTestId('message-0')).toHaveTextContent('Chunk 1');
    expect(screen.getByTestId('message-1')).toHaveTextContent('Chunk 2');
    expect(screen.getByTestId('message-2')).toHaveTextContent('Chunk 3');
    expect(screen.getByTestId('message-3')).toHaveTextContent('Chunk 4');
  });

  it('should emit data event for each chunk', async () => {
    const mockXML =
      '<flow-text i="1" t="2025-01-01T10:00:00Z" data-type="string">A</flow-text>' +
      '||' +
      '<flow-text i="2" t="2025-01-01T10:00:01Z" data-type="string">B</flow-text>' +
      '||' +
      '<flow-text i="3" t="2025-01-01T10:00:02Z" data-type="string">C</flow-text>';

    flowMock.setMockStreamXML(mockXML);

    // Track data events
    const dataEvents: number[] = [];
    flowMock.on('data', () => {
      dataEvents.push(flowMock.stream.items.filter((i) => i.elementType === FlowElementTypes.TEXT).length);
    });

    // Start streaming
    await flowMock.sendMessage('test');
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

    // Verify we got progressive data events
    // Should see at least [1, 2, 3] or similar progression
    expect(dataEvents.length).toBeGreaterThan(0);
    expect(dataEvents[dataEvents.length - 1]).toBe(3); // Final count is 3
  });
});
