/**
 * Test to validate FlowData source field is correctly set for streaming and history
 */

import { FlowDataSource } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../utils/stub/agentic_process_mock';

describe('FlowData Source Field Validation', () => {
  let flowMock: FlowMock;

  beforeEach(() => {
    flowMock = new FlowMock({ id: '550e8400-e29b-41d4-a716-446655440001' });
  });

  it('should set source=history for history-loaded FlowData', async () => {
    // Set mock history
    const mockHistory = [
      {
        role: 'user' as const,
        content: 'Test question',
        timestamp: new Date('2024-01-01T10:00:00Z').toISOString(),
      },
      {
        role: 'assistant' as const,
        content: '<flow-chat>Test answer</flow-chat>',
        timestamp: new Date('2024-01-01T10:00:01Z').toISOString(),
      },
    ];

    flowMock.setMockHistory(mockHistory);
    await flowMock.loadHistory();

    const history = flowMock.history;

    // Check that all history items have source=history
    expect(history.length).toBeGreaterThan(0);

    for (const item of history) {
      expect(item.source).toBe(FlowDataSource.History);
    }

    // Specifically check user message
    const userMessages = history.filter((item) => item.elementType === 'user-message');
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].source).toBe(FlowDataSource.History);

    // Specifically check assistant chat message
    const chatMessages = history.filter((item) => item.elementType === 'chat');
    expect(chatMessages.length).toBe(1);
    expect(chatMessages[0].source).toBe(FlowDataSource.History);
  });

  it('should set source=stream for streaming FlowData', async () => {
    // Set mock XML for streaming
    flowMock.setMockStreamXML('<flow-chat>Streaming response</flow-chat>');

    // Send a message to trigger streaming
    await flowMock.sendMessage('Test question');

    // Wait for stream to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    const streamData = flowMock.stream.items;

    // Check that all stream items have source=stream
    expect(streamData.length).toBeGreaterThan(0);

    for (const item of streamData) {
      expect(item.source).toBe(FlowDataSource.Stream);
    }

    // Specifically check chat message
    const chatMessages = streamData.filter((item) => item.elementType === 'chat');
    expect(chatMessages.length).toBe(1);
    expect(chatMessages[0].source).toBe(FlowDataSource.Stream);
  });

  it('should distinguish between history and stream sources', async () => {
    // 1. Load history first
    const mockHistory = [
      {
        role: 'assistant' as const,
        content: '<flow-chat>From history</flow-chat>',
        timestamp: new Date('2024-01-01T10:00:00Z').toISOString(),
      },
    ];

    flowMock.setMockHistory(mockHistory);
    await flowMock.loadHistory();

    const historyBefore = flowMock.history;
    const historyChat = historyBefore.find((item) => item.elementType === 'chat');
    expect(historyChat).toBeDefined();
    expect(historyChat!.source).toBe(FlowDataSource.History);

    // 2. Stream new message
    flowMock.setMockStreamXML('<flow-chat>From stream</flow-chat>');
    await flowMock.sendMessage('New question');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const streamData = flowMock.stream.items;
    // Find the chat message from the stream (by content to distinguish from history)
    const streamChat = streamData.find((item) => item.elementType === 'chat' && item.content === 'From stream');
    expect(streamChat).toBeDefined();
    expect(streamChat!.source).toBe(FlowDataSource.Stream);

    // 3. Verify both sources coexist
    const allItems = flowMock.stream.items;
    const historySources = allItems.filter((item) => item.source === FlowDataSource.History);
    const streamSources = allItems.filter((item) => item.source === FlowDataSource.Stream);

    expect(historySources.length).toBeGreaterThan(0);
    expect(streamSources.length).toBeGreaterThan(0);
  });

  it('should include source in FlowData toString() for debugging', async () => {
    // Load history
    const mockHistory = [
      {
        role: 'assistant' as const,
        content: '<flow-chat>Test</flow-chat>',
        timestamp: new Date('2024-01-01T10:00:00Z').toISOString(),
      },
    ];

    flowMock.setMockHistory(mockHistory);
    await flowMock.loadHistory();

    const history = flowMock.history;
    const chatMessage = history.find((item) => item.elementType === 'chat');

    expect(chatMessage).toBeDefined();

    // Check that toString includes source
    const str = chatMessage!.toString();
    expect(str).toContain('[history]');
  });
});
