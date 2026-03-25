import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReactChatTester } from '../../utils/stub';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

describe('Error Rendering in ChatTester', () => {
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

  const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('should render errors from both stream and history', async () => {
    // Create FlowMock for testing
    const testFlow = new FlowMock({
      title: 'Error Test Flow',
    });

    // Set mock history with an error message
    testFlow.setMockHistory([
      {
        role: 'user',
        content:
          '<flow-user-message i="1" t="2025-10-26T10:00:00.000Z" data-type="string">test command</flow-user-message>',
        timestamp: '2025-10-26T10:00:00.000Z',
      },
      {
        role: 'assistant',
        content:
          '<flow-error i="2" t="2025-10-26T10:00:01.000Z" data-type="string">Error from history: Command not found</flow-error>',
        timestamp: '2025-10-26T10:00:01.000Z',
      },
    ]);

    // Load history to populate the flow with history messages
    await testFlow.loadHistory();

    // Wait for history to be processed
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Render ReactChatTester
    render(
      <TestWrapper>
        <ReactChatTester flow={testFlow} debugMode={false} />
      </TestWrapper>,
    );

    // Wait for component to be ready
    await waitFor(() => {
      expect(screen.getByTestId('react-chat-tester')).toBeInTheDocument();
    });

    // Verify history error is rendered
    await waitFor(
      () => {
        const messages = screen.getByTestId('chat-messages');
        expect(messages).toBeInTheDocument();

        // Look for error message elements
        const errorElements = screen.getAllByTestId(/^message-error-/);
        expect(errorElements.length).toBeGreaterThanOrEqual(1);

        // Verify the history error content
        const historyError = errorElements.find((el) => el.textContent?.includes('Error from history'));
        expect(historyError).toBeDefined();
        expect(historyError?.textContent).toContain('Command not found');
      },
      { timeout: 3000 },
    );

    // Now inject a stream error by sending a message
    testFlow.setMockStreamXML(
      '<flow-user-message i="3" t="2025-10-26T10:00:02.000Z" data-type="string">/echo "test"</flow-user-message>||<flow-error i="4" t="2025-10-26T10:00:03.000Z" data-type="string">Tool echo is not supported.</flow-error>',
    );

    await testFlow.sendMessage('/echo "test"');

    // Wait for stream to complete and error to be rendered
    await waitFor(
      () => {
        const errorElements = screen.getAllByTestId(/^message-error-/);
        expect(errorElements.length).toBeGreaterThanOrEqual(2);

        // Verify the stream error content
        const streamError = errorElements.find((el) => el.textContent?.includes('Tool echo is not supported'));
        expect(streamError).toBeDefined();
        expect(streamError?.textContent).toContain('Tool echo is not supported');
      },
      { timeout: 3000 },
    );

    // Verify both errors are visible
    const allErrorElements = screen.getAllByTestId(/^message-error-/);
    expect(allErrorElements.length).toBe(2);

    // Verify error styling is correct (red background and border)
    allErrorElements.forEach((errorEl) => {
      expect(errorEl.className).toContain('bg-red-50');
      expect(errorEl.className).toContain('border-red-500');
    });
  });

  it('should render multiple errors in sequence', async () => {
    const testFlow = new FlowMock({
      title: 'Multiple Errors Test',
    });

    // Set mock stream with multiple errors
    testFlow.setMockStreamXML(
      '<flow-user-message i="1" t="2025-10-26T10:00:00.000Z" data-type="string">command1</flow-user-message>||<flow-error i="2" t="2025-10-26T10:00:01.000Z" data-type="string">First error occurred</flow-error>||<flow-user-message i="3" t="2025-10-26T10:00:02.000Z" data-type="string">command2</flow-user-message>||<flow-error i="4" t="2025-10-26T10:00:03.000Z" data-type="string">Second error occurred</flow-error>',
    );

    await testFlow.sendMessage('test');

    // Render component
    render(
      <TestWrapper>
        <ReactChatTester flow={testFlow} debugMode={false} />
      </TestWrapper>,
    );

    // Wait for component and errors to render
    await waitFor(
      () => {
        const errorElements = screen.getAllByTestId(/^message-error-/);
        expect(errorElements.length).toBe(2);

        // Verify first error
        expect(errorElements[0].textContent).toContain('First error occurred');

        // Verify second error
        expect(errorElements[1].textContent).toContain('Second error occurred');
      },
      { timeout: 3000 },
    );
  });

  it('should render error with proper testid format', async () => {
    const testFlow = new FlowMock({
      title: 'Error TestID Test',
    });

    testFlow.setMockStreamXML(
      '<flow-error i="1" t="2025-10-26T10:00:00.000Z" data-type="string">Test error message</flow-error>',
    );

    await testFlow.sendMessage('test');

    render(
      <TestWrapper>
        <ReactChatTester flow={testFlow} debugMode={false} />
      </TestWrapper>,
    );

    // Wait for error to be rendered with correct testid
    await waitFor(
      () => {
        // The message-error testid should follow the pattern message-error-{index}
        const errorElement = screen.getByTestId('message-error-0');
        expect(errorElement).toBeInTheDocument();
        expect(errorElement.textContent).toContain('Error:');
        expect(errorElement.textContent).toContain('Test error message');
      },
      { timeout: 3000 },
    );
  });
});
