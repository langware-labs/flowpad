import { Agent, dataManager, Flow, FlowExecutionStatus, UserAction } from '@sdk';
import { screen, waitFor } from '@testing-library/react';
import { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';
import { getChatAgentConfig } from './test-utils';
import { waitForRequest } from './waitForRequest';

/**
 * Create an agent and flow for testing
 */
export async function createTestAgentAndFlow(
  agentName: string,
  flowName: string,
): Promise<{ agent: Agent; flow: Flow }> {
  const agentConfig = getChatAgentConfig(agentName);
  const agent = new Agent(agentConfig.toAgentConstructor());
  await agent.save();

  const flow = await agent.createFlow(flowName);

  return { agent, flow };
}

/**
 * Wait for component to be ready
 */
export async function waitForComponentReady(): Promise<void> {
  try {
    await waitFor(() => {
      expect(screen.getByTestId('react-chat-tester')).toBeInTheDocument();
    });
  } catch {
    throw new Error('ReactChatTester component failed to mount or is not ready');
  }
}

/**
 * Wait for input to be ready to send
 */
export async function waitForInputReady(): Promise<void> {
  try {
    await waitFor(() => {
      expect(screen.getByTestId('input-status')).toHaveTextContent('Ready to send');
    });
  } catch {
    const currentStatus = screen.queryByTestId('input-status')?.textContent || 'not found';
    throw new Error(`Input not ready to send. Current status: "${currentStatus}"`);
  }
}

/**
 * Type message and send it
 */
export async function typeAndSendMessage(user: UserEvent, message: string): Promise<void> {
  try {
    await user.type(screen.getByTestId('chat-input'), message);

    // Wait for send button to appear after typing
    await waitFor(() => {
      expect(screen.getByTestId('send-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('send-button'));
  } catch (error) {
    throw new Error(`Failed to type and send message: "${message}". Error: ${String(error)}`);
  }
}

/**
 * Wait for user action count to increase
 * Returns a promise that resolves when the specified user action count increases
 */
export async function waitForUserAction(action: UserAction, timeout: number = 5000): Promise<void> {
  const testId = `user-action-${action.toLowerCase()}-count`;

  // Capture current count
  const initialCountElement = screen.queryByTestId(testId);
  const initialCount = parseInt(initialCountElement?.textContent || '0');
  const expectedCount = initialCount + 1;

  try {
    await waitFor(
      () => {
        const currentCountElement = screen.getByTestId(testId);
        const currentCount = parseInt(currentCountElement.textContent || '0');
        expect(currentCount).toBeGreaterThanOrEqual(expectedCount);
      },
      { timeout },
    );
  } catch {
    const finalCountElement = screen.queryByTestId(testId);
    const finalCount = parseInt(finalCountElement?.textContent || '0');
    throw new Error(
      `User action ${action} count did not increase. Initial: ${initialCount}, Expected: ${expectedCount}, Final: ${finalCount}`,
    );
  }
}

/**
 * Wait for streaming state to change
 */
export async function waitForStreaming(isStreaming: boolean, timeout: number = 13000): Promise<void> {
  try {
    await waitFor(
      () => {
        expect(screen.getByTestId('streaming-state')).toHaveTextContent(isStreaming ? 'true' : 'false');
      },
      { timeout },
    );
  } catch {
    const currentState = screen.queryByTestId('streaming-state')?.textContent || 'not found';
    throw new Error(`Streaming state did not change to ${isStreaming}. Current state: "${currentState}"`);
  }
}

/**
 * Cancel streaming and wait for completion
 */
export async function cancelStreamingAndWait(user: UserEvent): Promise<void> {
  // Check if currently streaming before attempting cancel
  const currentStreamingState = screen.queryByTestId('streaming-state')?.textContent;
  if (currentStreamingState !== 'true') {
    throw new Error(`Cannot cancel - not currently streaming. Current state: "${currentStreamingState}"`);
  }
  console.log('Cancelling streaming, number of requests: ', dataManager.apiStats.totalRequests);
  const waitForReuestPromise = waitForRequest();
  const cancelButton = screen.getByTestId('cancel-stream-button');
  await waitForFlowStatusOnStub(FlowExecutionStatus.Running);
  await user.click(cancelButton);
  try {
    // Wait for execution state to change to Canceled before checking requests
    await waitForFlowStatusOnStub(FlowExecutionStatus.Canceled);
    await waitForReuestPromise;
  } catch (error) {
    console.log('Cancelling streaming request error, number of requests: ', dataManager.apiStats.totalRequests);
    const streamingState = screen.queryByTestId('streaming-state')?.textContent || 'unknown';
    throw new Error(
      `Failed to cancel streaming. Current streaming state: "${streamingState}". Error: ${String(error)}`,
    );
  }
  try {
    // Verify streaming stopped
    await waitForStreaming(false, 5000);
  } catch (error) {
    const streamingState = screen.queryByTestId('streaming-state')?.textContent || 'unknown';
    throw new Error(
      `Failed to verify streaming stopped. Current streaming state: "${streamingState}". Error: ${String(error)}`,
    );
  }
}

/**
 * Wait for user message to appear in chat
 */
export async function waitForUserMessage(timeout: number = 5000): Promise<void> {
  try {
    await waitFor(
      () => {
        const messages = screen.getAllByTestId(/^message-\d+$/);
        const userMessage = messages.find((msg) => msg.getAttribute('data-role') === 'user');
        expect(userMessage).toBeDefined();
        expect(userMessage).toBeInTheDocument();
      },
      { timeout },
    );
  } catch {
    const messages = screen.queryAllByTestId(/^message-\d+$/);
    const messageCount = messages.length;
    const roles = messages.map((msg) => msg.getAttribute('data-role')).join(', ');
    throw new Error(`User message did not appear in chat. Total messages found: ${messageCount}. Roles: ${roles}`);
  }
}

/**
 * Wait for assistant message to appear in chat
 */
export async function waitForAssistantMessageOnStub(): Promise<void> {
  try {
    await waitFor(
      () => {
        const messages = screen.getAllByTestId(/^message-\d+$/);
        const assistantMessage = messages.find((msg) => msg.getAttribute('data-role') === 'assistant');
        expect(assistantMessage).toBeDefined();
        expect(assistantMessage).toBeInTheDocument();
      },
      { timeout: 15000 },
    );
  } catch {
    const messages = screen.queryAllByTestId(/^message-\d+$/);
    const messageCount = messages.length;
    const userMessages = messages.filter((msg) => msg.getAttribute('data-role') === 'user').length;
    const assistantMessages = messages.filter((msg) => msg.getAttribute('data-role') === 'assistant').length;
    throw new Error(
      `Assistant message did not appear in chat. Total messages: ${messageCount}, User messages: ${userMessages}, Assistant messages: ${assistantMessages}`,
    );
  }
}

/**
 * Wait for multiple messages to appear (more than specified count)
 */
export async function waitForMultipleMessages(minCount: number = 2): Promise<void> {
  try {
    await waitFor(
      () => {
        const statusMessages = screen.getAllByTestId(/^message-\d+$/);
        expect(statusMessages.length).toBeGreaterThan(minCount);
      },
      { timeout: 10000 },
    );
  } catch {
    const currentCount = screen.getAllByTestId(/^message-\d+$/).length;
    throw new Error(`Expected more than ${minCount} messages, but found ${currentCount} messages`);
  }
}

/**
 * Get final message count
 */
export function getFinalMessageCount(): number {
  return parseInt(screen.getByTestId('message-count').textContent || '0');
}

export async function waitForFlowStatusOnStub(
  status: FlowExecutionStatus | string,
  timeout: number = 10000,
): Promise<void> {
  // Check if it's a FlowExecutionStatus enum value
  const isExecutionState = Object.values(FlowExecutionStatus).includes(status as FlowExecutionStatus);

  if (isExecutionState) {
    // Wait for execution state
    const expectedState = status as FlowExecutionStatus;
    try {
      await waitFor(
        () => {
          // Check the execution state itself
          expect(screen.getByTestId('execution-state')).toHaveTextContent(expectedState);

          // Also check the corresponding boolean flag
          const flagTestId = `is-${expectedState.toLowerCase()}`;
          expect(screen.getByTestId(flagTestId)).toHaveTextContent('true');
        },
        { timeout },
      );
    } catch {
      const currentState = screen.queryByTestId('execution-state')?.textContent || 'not found';
      const flagTestId = `is-${expectedState.toLowerCase()}`;
      const currentFlag = screen.queryByTestId(flagTestId)?.textContent || 'not found';
      throw new Error(
        `Execution state did not change to ${expectedState}. Current state: "${currentState}", ${flagTestId}: "${currentFlag}"`,
      );
    }
  } else {
    throw new Error(
      `Invalid status parameter: "${status}". Only FlowExecutionStatus enum values are supported. status_line does not exist in Flow State.`,
    );
  }
}

/**
 * Wait for artifact result to arrive
 */
export async function waitForStubArtifact(timeout: number = 3000): Promise<void> {
  try {
    await waitFor(
      () => {
        expect(screen.getByTestId('has-artifact')).toHaveTextContent('true');
      },
      { timeout },
    );
  } catch {
    const currentHasArtifact = screen.queryByTestId('has-artifact')?.textContent || 'not found';
    const artifactCount = screen.queryByTestId('artifact-count')?.textContent || '0';
    throw new Error(
      `Artifact did not arrive within ${timeout}ms. Has artifact: "${currentHasArtifact}", Artifact count: "${artifactCount}"`,
    );
  }
}

/**
 * Verify initial component state
 */
export function verifyInitialState(flow: Flow): void {
  expect(screen.getByTestId('streaming-state')).toHaveTextContent('false');
  expect(screen.getByTestId('message-count')).toHaveTextContent('0');
  expect(screen.getByTestId('has-artifact')).toHaveTextContent('false');
  expect(screen.getByTestId('flow-id')).toHaveTextContent(flow.id);
}

/**
 * Get the current labels rendered in a labels block
 * @param scopeElementId - Optional ID of parent element to scope the search (finds labels-block within this element)
 * @returns Array of label text strings from the rendered chips
 */
export function getStubLabels(scopeElementId?: string): string[] {
  try {
    let labelsBlock: HTMLElement;

    if (scopeElementId) {
      // Find labels-block within the scoped element
      const scopeElement = screen.getByTestId(scopeElementId);
      const labelsBlockInScope = scopeElement.querySelector('[data-testid="labels-block"]');
      if (!labelsBlockInScope) {
        throw new Error(`No labels-block found within ${scopeElementId}`);
      }
      labelsBlock = labelsBlockInScope as HTMLElement;
    } else {
      // Find labels-block globally
      labelsBlock = screen.getByTestId('labels-block');
    }

    const chipSpans = labelsBlock.querySelectorAll('button > span');
    return Array.from(chipSpans).map((span) => span.textContent || '');
  } catch {
    return [];
  }
}

/**
 * Wait for labels to appear in a labels block
 * @param expectedLabels - Array of expected label strings
 * @param scopeElementId - Optional ID of parent element to scope the search
 * @param timeout - Optional timeout in ms (default 5000ms)
 */
export async function waitForLabels(
  expectedLabels: string[],
  scopeElementId?: string,
  timeout: number = 5000,
): Promise<void> {
  const scopeMsg = scopeElementId ? ` within ${scopeElementId}` : '';
  try {
    await waitFor(
      () => {
        const actualLabels = getStubLabels(scopeElementId);
        expect(actualLabels).toEqual(expectedLabels);
      },
      { timeout },
    );
  } catch {
    const actualLabels = getStubLabels(scopeElementId);
    throw new Error(
      `Expected labels${scopeMsg} to be ${JSON.stringify(expectedLabels)} but got ${JSON.stringify(actualLabels)}`,
    );
  }
}
