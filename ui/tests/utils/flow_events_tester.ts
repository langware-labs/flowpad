/**
 * Flow Events Tester - Utility for testing flow events in unit and integration tests
 */

export interface WaitForEventOptions {
  /** Event name to wait for */
  eventName: string;
  /** Maximum time to wait in milliseconds (default: 3000) */
  timeout?: number;
  /** Number of matching events to wait for (default: 1) */
  counter?: number;
  /** Expected arguments to match against event data (optional) */
  args?: any;
}

/**
 * Waits for a specific number of events with matching name and optional arguments
 *
 * @param flow - Flow instance to listen to events on
 * @param options - Event waiting configuration
 * @returns Promise that resolves to true if events were received, rejects with timeout error if timeout
 */
export async function waitForEvent(flow: any, options: WaitForEventOptions): Promise<boolean> {
  const { eventName, timeout = 3000, counter = 1, args } = options;

  return new Promise<boolean>((resolve, reject) => {
    let matchingEventCount = 0;

    const eventHandler = (eventData: any) => {
      // Check if args should be matched
      if (args !== undefined) {
        // If args provided, they must match
        if (JSON.stringify(eventData) === JSON.stringify(args)) {
          matchingEventCount++;
        }
      } else {
        // If no args provided, any event with this name counts
        matchingEventCount++;
      }

      // Check if we've received enough matching events
      if (matchingEventCount >= counter) {
        clearTimeout(timeoutId);
        flow.off(eventName, eventHandler);
        resolve(true);
      }
    };

    // Set up timeout
    const timeoutId = setTimeout(() => {
      flow.off(eventName, eventHandler);
      reject(new Error(`Timeout waiting for event '${eventName}' after ${timeout}ms`));
    }, timeout);

    // Listen for the event
    flow.on(eventName, eventHandler);
  });
}

/**
 * Convenience function for waiting for a single event without arguments
 */
export async function waitForEventSimple(flow: any, eventName: string, timeout = 3000): Promise<boolean> {
  return waitForEvent(flow, { eventName, timeout });
}

/**
 * Convenience function for waiting for multiple events of the same type
 */
export async function waitForMultipleEvents(
  flow: any,
  eventName: string,
  count: number,
  timeout = 3000,
): Promise<boolean> {
  return waitForEvent(flow, { eventName, counter: count, timeout });
}

/**
 * Convenience function for waiting for an event with specific arguments
 */
export async function waitForEventWithArgs(flow: any, eventName: string, args: any, timeout = 3000): Promise<boolean> {
  return waitForEvent(flow, { eventName, args, timeout });
}

// =============================================================================
// Flow-specific event helpers
// =============================================================================

/**
 * Wait for user message to be sent
 */
export async function waitForUserMessage(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:user-message', timeout });
}

/**
 * Wait for assistant message to be received
 */
export async function waitForAssistantMessage(flow: any, timeout = 10000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:assistant-message', timeout });
}

/**
 * Wait for result/artifact to be generated
 */
export async function waitForResult(flow: any, timeout = 15000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:result', timeout });
}

/**
 * Wait for any artifact to be created
 */
export async function waitForArtifactEvent(flow: any, timeout = 15000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:artifact', timeout });
}

/**
 * Wait for status line update
 */
export async function waitForStatusLine(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:status_line', timeout });
}

/**
 * Wait for focus line update
 */
export async function waitForFocusLine(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:focus_line', timeout });
}

/**
 * Wait for reasoning/thinking data
 */
export async function waitForReasoning(flow: any, timeout = 10000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:reasoning', timeout });
}

/**
 * Wait for shell command execution
 */
export async function waitForShell(flow: any, timeout = 10000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:shell', timeout });
}

/**
 * Wait for write operation (file creation/modification)
 */
export async function waitForWrite(flow: any, timeout = 10000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:write', timeout });
}

/**
 * Wait for search operation
 */
export async function waitForSearch(flow: any, timeout = 10000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'data:search', timeout });
}

// =============================================================================
// Stream state helpers
// =============================================================================

/**
 * Wait for streaming to start
 */
export async function waitForStreamStart(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'stream:start', timeout });
}

/**
 * Wait for streaming to end
 */
export async function waitForStreamEnd(flow: any, timeout = 15000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'stream:end', timeout });
}

/**
 * Wait for element processing to start
 */
export async function waitForElementStart(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'stream:element_start', timeout });
}

/**
 * Wait for element processing to complete
 */
export async function waitForElementEnd(flow: any, timeout = 10000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'stream:element_end', timeout });
}

// =============================================================================
// User action helpers
// =============================================================================

/**
 * Wait for user run action
 */
export async function waitForUserRun(flow: any, timeout = 3000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'user:run', timeout });
}

/**
 * Wait for user cancel action
 */
export async function waitForUserCancel(flow: any, timeout = 3000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'user:cancel', timeout });
}

/**
 * Wait for user resume action
 */
export async function waitForUserResume(flow: any, timeout = 3000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'user:resume', timeout });
}

// =============================================================================
// Error and log helpers
// =============================================================================

/**
 * Wait for error event
 */
export async function waitForError(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'error', timeout });
}

/**
 * Wait for log event
 */
export async function waitForLog(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'log', timeout });
}

/**
 * Wait for debug event
 */
export async function waitForDebug(flow: any, timeout = 5000): Promise<boolean> {
  return waitForEvent(flow, { eventName: 'debug', timeout });
}

// =============================================================================
// Composite helpers for common test scenarios
// =============================================================================

/**
 * Wait for a complete message exchange (user + assistant)
 */
export async function waitForMessageExchange(flow: any, timeout = 15000): Promise<boolean> {
  const userMsgReceived = await waitForUserMessage(flow, timeout);
  if (!userMsgReceived) return false;

  return await waitForAssistantMessage(flow, timeout);
}

/**
 * Wait for a complete flow with result
 */
export async function waitForCompleteFlow(flow: any, timeout = 15000): Promise<boolean> {
  const streamStarted = await waitForStreamStart(flow, 5000);
  if (!streamStarted) return false;

  const resultReceived = await waitForResult(flow, timeout);
  if (!resultReceived) return false;

  return await waitForStreamEnd(flow, 10000);
}
