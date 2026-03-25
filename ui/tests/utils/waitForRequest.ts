import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import { dataManager } from '@sdk';

/**
 * Wait for API requests to complete using dataManager stats
 * @param count Number of additional requests to wait for (default: 1)
 * @param timeout Timeout in milliseconds (default: 3000)
 */
export async function waitForRequest(count: number = 1, timeout: number = 3000): Promise<void> {
  // Capture current total request count
  const initialTotal = dataManager.apiStats.totalRequests;
  const targetTotal = initialTotal + count;

  // Wait for the target number of requests to be reached
  try {
    await waitFor(
      () => {
        const currentTotal = dataManager.apiStats.totalRequests;
        expect(currentTotal).toBeGreaterThanOrEqual(targetTotal);
      },
      { timeout },
    );
  } catch (_error) {
    throw new Error(`Waiting for ${count} more requests. Current: ${initialTotal}, Target: ${targetTotal}`);
  }
}
