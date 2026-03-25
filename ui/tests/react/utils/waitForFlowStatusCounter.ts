import { waitFor } from '@testing-library/react';
import { Flow } from '@sdk';
import { FlowExecutionStatus } from '@sdk';

/**
 * Wait for a specific flow status counter to reach an expected value
 * @param flow - The Flow instance to monitor
 * @param status - The execution status to check
 * @param expectedCount - The expected counter value
 * @param timeout - Optional timeout in ms (default 200ms)
 */
export async function waitForFlowStatusCounter(
  flow: Flow,
  status: FlowExecutionStatus,
  expectedCount: number,
  timeout: number = 200,
): Promise<void> {
  await waitFor(
    () => {
      const actualCount = flow.statusCounters[status] || 0;
      if (actualCount !== expectedCount) {
        throw new Error(`Expected ${status} counter to be ${expectedCount} but got ${actualCount}`);
      }
    },
    { timeout },
  );
}

/**
 * Wait for the running counter specifically
 * @param flow - The Flow instance to monitor
 * @param expectedCount - The expected counter value
 * @param timeout - Optional timeout in ms (default 200ms)
 */
export async function waitForRunningCounter(flow: Flow, expectedCount: number, timeout: number = 200): Promise<void> {
  await waitFor(
    () => {
      const actualCount = flow.runningCounter;
      if (actualCount !== expectedCount) {
        throw new Error(`Expected runningCounter to be ${expectedCount} but got ${actualCount}`);
      }
    },
    { timeout },
  );
}
