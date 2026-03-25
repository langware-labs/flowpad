import { FlowElementTypes, FlowEvents } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

describe('User Message Events', () => {
  beforeEach(async () => {
    // Reset data manager to ensure clean state between tests
    await unitTestSetup();
  });

  it('should output exact user message with parameterized scenario', async () => {
    const flow = new FlowMock({ title: 'Test Flow' });
    const userMessage = 'Create a Python script that prints "Hello, World!"';

    // Use the parameterized userMessage scenario with timestamp
    let timestamp = new Date().toISOString();
    timestamp = new Date(new Date(timestamp).getTime() + 100).toISOString();

    flow.setMockStreamXML(`<flow-user-message t="${timestamp}">${userMessage}</flow-user-message>`);
    await flow.sendMessage('test message');
    // Wait for stream processing to complete
    await new Promise<void>((resolve) => {
      const unsubscribe = flow.on(FlowEvents.STREAM_END, () => {
        unsubscribe();
        resolve();
      });

      // Timeout fallback in case stream:end is not emitted
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, 500);
    });

    // Access stream directly - pure FlowData format
    // Stream has 2 items sorted by timestamp
    // Mock XML timestamp is +100ms from current time (line 18), so it appears AFTER the sendMessage timestamp
    expect(flow.stream.items).toHaveLength(2);

    // Index 0 is the optimistic UI message from sendMessage() call (earlier timestamp)
    expect(flow.stream.items[0].elementType).toBe('user-message');
    expect(flow.stream.items[0].content).toBe('test message');

    // Index 1 is the mockXML user message (later timestamp from test setup + 100ms)
    expect(flow.stream.items[1].elementType).toBe('user-message');
    expect(flow.stream.items[1].content).toBe(userMessage);
  });

  it('should handle user messages with special characters', async () => {
    const flow = new FlowMock({ title: 'Test Flow' });
    const userMessage = 'Special chars: <>{}[]()&"\'\\|/!@#$%^*+=~`?';

    flow.setMockStreamXML(`<flow-user-message>${userMessage}</flow-user-message>`);
    await flow.sendMessage('test message');
    await new Promise<void>((resolve) => {
      const unsubscribe = flow.on(FlowEvents.STREAM_END, () => {
        unsubscribe();
        resolve();
      });

      // Timeout fallback in case stream:end is not emitted
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, 500);
    });

    expect(flow.stream.items).toHaveLength(2);
    expect(flow.stream.items[1].elementType).toBe('user-message');
    expect(flow.stream.items[1].content).toBe(userMessage);
  });

  it('should handle multi-line user messages', async () => {
    const flow = new FlowMock({ title: 'Test Flow' });
    const userMessage = `Create a file with this content:
Line 1: Hello
Line 2: World
Line 3: End`;

    flow.setMockStreamXML(`<flow-user-message>${userMessage}</flow-user-message>`);
    await flow.sendMessage('test message');
    await new Promise<void>((resolve) => {
      const unsubscribe = flow.on(FlowEvents.STREAM_END, () => {
        unsubscribe();
        resolve();
      });

      // Timeout fallback in case stream:end is not emitted
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, 500);
    });

    expect(flow.stream.items).toHaveLength(2);
    expect(flow.stream.items[1].elementType).toBe('user-message');
    expect(flow.stream.items[1].content).toBe(userMessage);
  });

  it('should handle minimal user message', async () => {
    const flow = new FlowMock({ title: 'Test Flow' });
    const userMessage = 'ok'; // Use minimal but non-empty message

    flow.setMockStreamXML(`<flow-user-message>${userMessage}</flow-user-message>`);
    await flow.sendMessage('test message');
    await new Promise<void>((resolve) => {
      const unsubscribe = flow.on(FlowEvents.STREAM_END, () => {
        unsubscribe();
        resolve();
      });

      // Timeout fallback in case stream:end is not emitted
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, 500);
    });

    expect(flow.stream.items).toHaveLength(2);
    expect(flow.stream.items[1].elementType).toBe('user-message');
    expect(flow.stream.items[1].content).toBe('ok');
  });

  it('should handle user message with response scenario', async () => {
    const flow = new FlowMock({ title: 'Test Flow' });
    const userMessage = 'What is the capital of France?';
    const agentResponse = 'The capital of France is Paris.';

    // Track user-message events specifically
    const userMessageEvents: any[] = [];
    flow.on(FlowEvents.DATA_END, (data: any) => {
      if (data?.elementType === FlowElementTypes.USER_MESSAGE) {
        userMessageEvents.push(data);
      }
    });

    flow.setMockStreamXML(
      `<flow-user-message>${userMessage}</flow-user-message>||<flow-text>${agentResponse}</flow-text>`,
    );
    await flow.sendMessage('test message');
    await new Promise<void>((resolve) => {
      const unsubscribe = flow.on(FlowEvents.STREAM_END, () => {
        unsubscribe();
        resolve();
      });

      // Timeout fallback in case stream:end is not emitted
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, 500);
    });

    // Should have 3 messages total: sendMessage user-message + mockXML user-message + text
    expect(flow.stream.items).toHaveLength(3);

    // Second message should be the mockXML user message (index 1, after sendMessage user msg at 0)
    expect(flow.stream.items[1].elementType).toBe('user-message');
    expect(flow.stream.items[1].content).toBe(userMessage);

    // Third should be the agent response
    expect(flow.stream.items[2].elementType).toBe('text');
    expect(flow.stream.items[2].content).toBe(agentResponse);

    // Should have captured exactly one user-message event
    expect(userMessageEvents).toHaveLength(1);
    expect(userMessageEvents[0].content).toBe(userMessage);
  });

  it('should handle user message with very long content', async () => {
    const flow = new FlowMock({ title: 'Test Flow' });
    // Use reduced parameters on Windows for faster test execution
    const isWindows = process.platform === 'win32';
    const messageLength = isWindows ? 1000 : 5000;
    const fallbackTimeout = isWindows ? 3000 : 5000;

    const longMessage = 'A'.repeat(messageLength) + ' - end of very long message';
    flow.streamChunkDelay = 1;
    // Use || delimiter to control chunking and prevent random XML splitting
    flow.setMockStreamXML(`<flow-user-message>${longMessage}</flow-user-message>`);
    await flow.sendMessage('test message');
    await new Promise<void>((resolve) => {
      const unsubscribe = flow.on(FlowEvents.STREAM_END, () => {
        unsubscribe();
        resolve();
      });

      // Timeout fallback in case stream:end is not emitted
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, fallbackTimeout);
    });

    expect(flow.stream.items).toHaveLength(2);
    expect(flow.stream.items[1].elementType).toBe('user-message');
    expect(flow.stream.items[1].content).toBe(longMessage);
    // Check actual length instead of hardcoded value
    expect(flow.stream.items[1].content.length).toBe(longMessage.length);
  }, 10000); // Increased timeout for all platforms to allow fallback timeout to complete // Set test timeout to 10 seconds on Windows to accommodate streaming with delay

  it('should handle user message with parameterized file creation scenario', async () => {
    const flow = new FlowMock({ title: 'Test Flow' });
    const filename = 'test.py';
    const content = 'print("Hello from parameterized test!")';
    const userMessage = `Create ${filename} with content "${content}"`;

    // Track all user-message events
    const userMessageEvents: any[] = [];
    flow.on(FlowEvents.DATA_END, (data: any) => {
      if (data?.elementType === FlowElementTypes.USER_MESSAGE) {
        userMessageEvents.push(data);
      }
    });

    flow.setMockStreamXML(
      `<flow-user-message>${userMessage}</flow-user-message>||<flow-text>Creating file: ${filename}</flow-text>||<flow-result data-type="object">{"type": "artifact", "id": "12345678-1234-4567-8901-123456789012", "name": "${filename}", "ref_type": "file", "path": "${filename}", "description": "Created file", "metadata": {"content": "${content.replace(/"/g, '\\"')}"}}</flow-result>`,
    );
    await flow.sendMessage('test message');
    await new Promise<void>((resolve) => {
      const unsubscribe = flow.on(FlowEvents.STREAM_END, () => {
        unsubscribe();
        resolve();
      });

      // Timeout fallback in case stream:end is not emitted
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, 500);
    });

    // Should have 4 messages: sendMessage user msg + mockXML user-message + text + result
    expect(flow.stream.items).toHaveLength(4);

    // Second should be mockXML user message with exact parameterized content (index 1)
    expect(flow.stream.items[1].elementType).toBe('user-message');
    expect(flow.stream.items[1].content).toBe(userMessage);

    // Third should be the text response (index 2)
    expect(flow.stream.items[2].elementType).toBe('text');
    expect(flow.stream.items[2].content).toBe(`Creating file: ${filename}`);

    // Fourth should be the result with artifact data (index 3)
    expect(flow.stream.items[3].elementType).toBe('result');

    // Debug: Check the exact JSON content being processed
    console.log('Content with escapes:', content.replace(/"/g, '\\"'));
    console.log(
      'Full JSON:',
      `{"type": "artifact", "id": "12345678-1234-4567-8901-123456789012", "name": "${filename}", "ref_type": "file", "path": "${filename}", "description": "Created file", "metadata": {"content": "${content.replace(/"/g, '\\"')}"}}`,
    );
    console.log('FlowData structure:', JSON.stringify(flow.stream.items[3].data, null, 2));

    // FlowData has parsed JSON in .data property (result is at index 3)
    expect(flow.stream.items[3].data.name).toBe(filename);
    expect(flow.stream.items[3].data.type).toBe('artifact');

    // Should have exactly one user-message event
    expect(userMessageEvents).toHaveLength(1);
    expect(userMessageEvents[0].content).toBe(userMessage);
  });
});
