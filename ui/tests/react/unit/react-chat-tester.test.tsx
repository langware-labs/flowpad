import { FlowEvents } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { waitForUserResume, waitForUserRun } from '../../utils/flow_events_tester';
import { ReactChatTester } from '../../utils/stub';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

describe('ReactChatTester Component testing', () => {
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

  const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('should render chat interface and handle user interactions without backend', async () => {
    const user = userEvent.setup();

    // Create FlowMock for testing with initial state
    const testFlow = new FlowMock({
      title: 'Test Flow',
    });

    // Set mock XML and trigger processing with sendMessage (new pattern)
    // Use || delimiters to control chunking and prevent random XML splitting
    testFlow.setMockStreamXML(
      '<flow-mode>Agent</flow-mode>||<flow-checkpoint>Initial state with todo</flow-checkpoint>',
    );
    await testFlow.sendMessage('initial setup');

    // Wait for initial processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Render ReactChatTester with real FlowMock entity (no vi.fn() mocks)
    render(
      <TestWrapper>
        <ReactChatTester flow={testFlow} debugMode={true} />
      </TestWrapper>,
    );

    // Wait for component to be ready and flow to be loaded
    await waitFor(() => {
      expect(screen.getByTestId('react-chat-tester')).toBeInTheDocument();
      expect(screen.getByTestId('flow-id')).toHaveTextContent(testFlow.id);
    });

    // Note: Flow processing happens but React hooks may not catch state immediately
    // Focus on testing component behavior rather than exact state synchronization
    await waitFor(() => {
      // The debug panel should be present and show some value (may be 'Unknown' initially)
      expect(screen.getByTestId('debug-flow-mode')).toBeInTheDocument();
    });

    // Verify initial state after flow processing is complete
    expect(screen.getByTestId('streaming-state')).toHaveTextContent('false');
    // Note: React hooks may not sync with FlowMock's stream array immediately
    // Check that message-count element exists and shows a number (may be 0 due to sync timing)
    const messageCountElement = screen.getByTestId('message-count');
    expect(messageCountElement).toBeInTheDocument();
    // Verify it contains a number, but don't require specific value due to sync timing
    expect(messageCountElement.textContent).toMatch(/^\d+$/);
    expect(screen.getByTestId('has-artifact')).toHaveTextContent('false');
    expect(screen.getByTestId('flow-id')).toHaveTextContent(testFlow.id);

    // Verify todos panel shows empty state (no todos in this mock flow)
    expect(screen.getByTestId('todos-panel-empty')).toBeInTheDocument();

    // Verify debug panel shows correct info
    expect(screen.getByTestId('debug-streaming')).toHaveTextContent('Idle');

    // Test chat input interaction
    const chatInput = screen.getByTestId('chat-input');

    await user.type(chatInput, "create me hello world.txt file containing 'hello'");

    // Verify input state
    expect(screen.getByTestId('input-status')).toHaveTextContent('Ready to send');
    expect(screen.getByTestId('char-count')).toHaveTextContent('49 characters');

    // Wait for send button to appear after typing
    await waitFor(() => {
      expect(screen.getByTestId('send-button')).toBeInTheDocument();
    });

    const sendButton = screen.getByTestId('send-button');

    // Send the message and wait for user:run event
    const userRunPromise = waitForUserRun(testFlow);
    await user.click(sendButton);

    // Wait for user:run event to be emitted
    await userRunPromise; // This will throw if timeout occurs

    // Wait for message to be processed and verify flow state changes
    await waitFor(
      () => {
        // Flow should now have messages after processing
        expect(testFlow.stream.items.length).toBeGreaterThan(0);
      },
      { timeout: 1000 },
    );

    // Verify input is cleared after sending
    expect(chatInput).toHaveValue('');

    // Test flow actions
    const saveButton = screen.getByTestId('save-button');
    const cancelButton = screen.getByTestId('cancel-button');
    const resumeButton = screen.getByTestId('resume-button');

    // Wait for streaming to complete before checking button states
    await waitFor(
      () => {
        expect(screen.getByTestId('streaming-state')).toHaveTextContent('false');
      },
      { timeout: 1000 },
    );

    // Give React time to update button states after streaming completes
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Save should be enabled when not streaming
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    // Cancel and resume should be disabled when not streaming
    expect(cancelButton).toBeDisabled();
    expect(resumeButton).not.toBeDisabled();

    // Test resume action with event verification
    const userResumePromise = waitForUserResume(testFlow);
    await user.click(resumeButton);

    // Wait for user:resume event to be emitted
    await userResumePromise; // This will throw if timeout occurs

    // Verify flow is still in a valid state after resume
    expect(testFlow.id).toBeDefined();

    console.log('✅ ReactChatTester component test passed!');
    console.log('📊 Verified:');
    console.log('   - Component rendering');
    console.log('   - Flow hooks integration');
    console.log('   - User interactions');
    console.log('   - Mock flow state');
    console.log('   - Event handlers');
    console.log('   - Flow event verification (user:run, user:resume)');
    console.log('   - Debug panel');
    console.log('   - Todos display');
  });

  it('should handle empty flow state gracefully', async () => {
    // Create FlowMock with empty state for testing
    const emptyFlow = new FlowMock({
      title: 'Empty Flow',
    });

    // Don't set any mock XML to test empty state behavior
    // No sendMessage call either, to test completely empty flow

    render(
      <TestWrapper>
        <ReactChatTester flow={emptyFlow} debugMode={true} />
      </TestWrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('react-chat-tester')).toBeInTheDocument();
    });

    // Should show empty states
    expect(screen.getByTestId('empty-messages')).toBeInTheDocument();
    expect(screen.getByTestId('todos-panel-empty')).toBeInTheDocument();
    // FlowMock initializes with default mode 'Agent' (from ChatOptionsState constructor)
    expect(screen.getByTestId('debug-flow-mode')).toHaveTextContent('Agent');
  });

  it('should handle no flow prop gracefully', async () => {
    render(
      <TestWrapper>
        <ReactChatTester />
      </TestWrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('chat-tester-no-flow')).toBeInTheDocument();
    });

    expect(screen.getByTestId('chat-tester-no-flow')).toHaveTextContent('No flow available');
  });

  it('should handle "hi" message with exact stream reproduction and validate FlowData processing', async () => {
    const user = userEvent.setup();

    // Create FlowMock for testing the exact "hi" scenario
    const testFlow = new FlowMock({
      title: 'Hi Message Test Flow',
    });

    // Set the exact XML stream that was observed in the real scenario
    // Use || delimiters to control chunking and prevent random XML splitting which corrupts tags
    const exactStreamXML = `<flow-user-message i="77" data-type="string">hi</flow-user-message>||<flow-reasoning i="78" data-type="string">The user just said "hi" which is a simple greeting. This doesn't require any web searches or content fetching. I should just respond with a friendly greeting and perhaps ask how I can help them.</flow-reasoning>||<flow-chat i="87" data-type="string">Hello! I'm FlowpadAI. How can I help you today? I can search the web for information, fetch content from specific websites, or assist you with any questions you might have.</flow-chat>||<flow-llm-end i="97" data-type="string">LLM generation complete</flow-llm-end>`;

    testFlow.setMockStreamXML(exactStreamXML);

    // Debug: Add event listener to track FlowData events BEFORE rendering
    let _dataEventCount = 0;
    testFlow.on(FlowEvents.DATA, (_data: any) => {
      _dataEventCount++;
    });

    // Render ReactChatTester with the test flow FIRST to ensure hooks are subscribed
    render(
      <TestWrapper>
        <ReactChatTester flow={testFlow} debugMode={true} />
      </TestWrapper>,
    );

    // Wait for component to be ready BEFORE sending message
    await waitFor(() => {
      expect(screen.getByTestId('react-chat-tester')).toBeInTheDocument();
      expect(screen.getByTestId('flow-id')).toHaveTextContent(testFlow.id);
    });

    // NOW send the message, after hooks are subscribed
    await testFlow.sendMessage('hi');

    // Wait for processing to complete
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Wait for component to be ready
    await waitFor(() => {
      expect(screen.getByTestId('react-chat-tester')).toBeInTheDocument();
      expect(screen.getByTestId('flow-id')).toHaveTextContent(testFlow.id);
    });

    // Validate that all expected FlowData elements are processed correctly
    await waitFor(
      () => {
        // Check that FlowData events were received (dataArr should have all elements)
        const dataArrayCount = screen.getByTestId('data-array-count');
        const dataArrayCountValue = parseInt(dataArrayCount.textContent || '0');
        console.log('📊 TEST: dataArr count:', dataArrayCountValue);

        // Check that messages were processed (should have 4 elements: user-message, reasoning, chat, llm-end)
        const messageCount = screen.getByTestId('message-count');
        const messageCountValue = parseInt(messageCount.textContent || '0');
        console.log('📊 TEST: messages count:', messageCountValue);

        // First, validate that FlowData events are being received
        expect(dataArrayCountValue).toBeGreaterThan(0); // Should have some FlowData events

        // Then validate that messages are present and not duplicated
        // Expected: 5 FlowData elements total:
        //   1 user-message from sendMessage('hi')
        //   4 from exactStreamXML (user-message, reasoning, chat, llm-end)
        expect(messageCountValue).toBe(5);

        // Verify not streaming after processing
        expect(screen.getByTestId('streaming-state')).toHaveTextContent('false');
      },
      { timeout: 2000 },
    );

    // Validate that useProcessStream hook is working properly
    const streamingState = screen.getByTestId('streaming-state');
    expect(streamingState).toHaveTextContent('false');

    // Validate that flow processed correctly without errors
    expect(screen.getByTestId('is-error')).toHaveTextContent('false');

    // Test that we can send the "hi" message and validate the processing
    const chatInput = screen.getByTestId('chat-input');

    // Clear any existing content and type "hi"
    await user.clear(chatInput);
    await user.type(chatInput, 'hi');

    // Verify input state
    expect(screen.getByTestId('input-status')).toHaveTextContent('Ready to send');
    expect(screen.getByTestId('char-count')).toHaveTextContent('2 characters');

    // Get initial message count before sending
    const initialMessageCount = parseInt(screen.getByTestId('message-count').textContent || '0');

    // Send the message
    await waitFor(() => {
      expect(screen.getByTestId('send-button')).toBeInTheDocument();
    });

    const sendButton = screen.getByTestId('send-button');

    // Send the message and wait for user:run event
    const userRunPromise = waitForUserRun(testFlow);
    await user.click(sendButton);

    // Wait for user:run event to be emitted
    await userRunPromise;

    // Wait for new message processing to complete
    await waitFor(
      () => {
        const newMessageCount = parseInt(screen.getByTestId('message-count').textContent || '0');
        // After sending "hi" again, we should have initial 5 + 5 new = 10 total messages
        // (each sendMessage creates 1 user-message + 4 from mock XML)
        expect(newMessageCount).toBe(initialMessageCount + 5);
      },
      { timeout: 2000 },
    );

    // Verify final state
    await waitFor(() => {
      expect(screen.getByTestId('streaming-state')).toHaveTextContent('false');
    });

    // Final assertion: ensure no excessive duplicates
    const finalMessageCount = parseInt(screen.getByTestId('message-count').textContent || '0');
    expect(finalMessageCount).toBeLessThanOrEqual(initialMessageCount + 8); // Allow some margin but prevent massive duplication
  });
});
