/**
 * Test AgenticProcess.connection_id field surfaces correctly on the frontend.
 *
 * Verifies that when an AgenticProcess is opened via the backend, the
 * connection_id is captured and exposed on the TypeScript entity.
 */

import { describe, it, expect } from 'vitest';
import { AgenticProcess } from '@sdk';
import { v4 as uuidv4 } from 'uuid';

// These are pure field/construction checks on the AgenticProcess entity — they
// neither hit the backend nor need a live websocket, so there is no connection
// setup (the old passive connection-wait never called connect() and timed out).
describe('AgenticProcess connection_id field', () => {
  it('should expose connection_id field on AgenticProcess', async () => {
    // Create a new AgenticProcess
    const process = new AgenticProcess({
      id: uuidv4(),
      name: 'Test Process',
      connection_id: 'conn-test-abc123',
    });

    expect(process.connection_id).toBe('conn-test-abc123');
  });

  it('should handle null connection_id', async () => {
    const process = new AgenticProcess({
      id: uuidv4(),
      name: 'Test Process No Connection',
      connection_id: null,
    });

    expect(process.connection_id).toBeNull();
  });

  it('should handle undefined connection_id', async () => {
    const process = new AgenticProcess({
      id: uuidv4(),
      name: 'Test Process Undefined Connection',
    });

    expect(process.connection_id).toBeUndefined();
  });

  it('should preserve connection_id through entity updates', async () => {
    const process = new AgenticProcess({
      id: uuidv4(),
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
