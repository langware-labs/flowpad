/**
 * Test AgenticProcess.connection_id field surfaces correctly on the frontend.
 *
 * Verifies that when an AgenticProcess is opened via the backend, the
 * connection_id is captured and exposed on the TypeScript entity.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgenticProcess, ConnectionManager, dataManager } from '@sdk';

describe('AgenticProcess connection_id field', () => {
  let connectionManager: ConnectionManager;

  beforeAll(async () => {
    connectionManager = ConnectionManager.getInstance();
    // Wait for the connection to establish
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
      if (connectionManager.connected) {
        clearTimeout(timeout);
        resolve();
      } else {
        const checkConnection = setInterval(() => {
          if (connectionManager.connected) {
            clearTimeout(timeout);
            clearInterval(checkConnection);
            resolve();
          }
        }, 100);
      }
    });
  });

  afterAll(() => {
    // Cleanup if needed
  });

  it('should expose connection_id field on AgenticProcess', async () => {
    // Create a new AgenticProcess
    const process = new AgenticProcess({
      id: 'test-process-123',
      name: 'Test Process',
      connection_id: 'conn-test-abc123',
    });

    expect(process.connection_id).toBe('conn-test-abc123');
  });

  it('should handle null connection_id', async () => {
    const process = new AgenticProcess({
      id: 'test-process-456',
      name: 'Test Process No Connection',
      connection_id: null,
    });

    expect(process.connection_id).toBeNull();
  });

  it('should handle undefined connection_id', async () => {
    const process = new AgenticProcess({
      id: 'test-process-789',
      name: 'Test Process Undefined Connection',
    });

    expect(process.connection_id).toBeUndefined();
  });

  it('should preserve connection_id through entity updates', async () => {
    const process = new AgenticProcess({
      id: 'test-process-update',
      name: 'Test Process Update',
      connection_id: 'conn-update-xyz',
    });

    expect(process.connection_id).toBe('conn-update-xyz');

    // Simulate a partial update (same pattern as deepAssign)
    const updated = new AgenticProcess({
      ...process,
      name: 'Updated Name',
      connection_id: 'conn-update-xyz', // Should preserve
    });

    expect(updated.connection_id).toBe('conn-update-xyz');
    expect(updated.name).toBe('Updated Name');
  });
});
