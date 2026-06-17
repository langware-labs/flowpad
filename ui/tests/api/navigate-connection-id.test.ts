/**
 * Test navigate entity with explicit --connection-id flag.
 *
 * Verifies that when POSTing to /api/v1/agent/navigate/entity with a
 * connection_id parameter, the navigation message is routed to the specific
 * WS connection, not the "active" one.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ConnectionManager, dataManager, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';

describe('navigate entity with explicit connection_id', () => {
  let connectionManager: ConnectionManager;
  let testProject: Project;

  beforeAll(async () => {
    connectionManager = ConnectionManager.getInstance();

    // Wait for connection to establish
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

    // Create a test project for navigation
    testProject = new Project({
      id: 'test-project-nav',
      name: 'Navigation Test Project',
      uname: '@nav-test',
      visitor_role: 'owner',
    });

    try {
      await testProject.save();
    } catch (e) {
      // Project might already exist; continue
    }
  });

  it('should route navigation to the specified connection_id', async () => {
    const typeid = new TypeId('project', testProject.id);

    // POST to navigate with explicit connection_id
    const response = await apiClient.post('/api/v1/agent/navigate/entity', {
      typeid: typeid.toString(),
      connection_id: connectionManager.connection_id, // Target this connection
    });

    // Verify successful response
    expect(response.status).toBe(200);
    const body = response.data;
    expect(body.ok).toBe(true);
    expect(body.connection_id).toBe(connectionManager.connection_id);
    expect(body.type).toBe('project');
    expect(body.id).toBe(testProject.id);
  });

  it('should return CONNECTION_NOT_FOUND for invalid connection_id', async () => {
    const typeid = new TypeId('project', testProject.id);
    const invalidConnectionId = 'conn-invalid-xyz-does-not-exist';

    // POST with an invalid connection_id
    try {
      await apiClient.post('/api/v1/agent/navigate/entity', {
        typeid: typeid.toString(),
        connection_id: invalidConnectionId,
      });
      // Should not reach here
      expect.fail('Expected request to fail with CONNECTION_NOT_FOUND');
    } catch (error: any) {
      // Expect a 404 response
      expect(error.response.status).toBe(404);
      const body = error.response.data;
      expect(body.ok).toBe(false);
      expect(body.error_code).toBe('CONNECTION_NOT_FOUND');
    }
  });

  it('should navigate to active tab when connection_id is omitted', async () => {
    const typeid = new TypeId('project', testProject.id);

    // POST without connection_id — should use active tab
    const response = await apiClient.post('/api/v1/agent/navigate/entity', {
      typeid: typeid.toString(),
    });

    // Verify successful response
    expect(response.status).toBe(200);
    const body = response.data;
    expect(body.ok).toBe(true);
    expect(body.connection_id).toBeDefined(); // Should pick the active connection
    expect(body.type).toBe('project');
    expect(body.id).toBe(testProject.id);
  });
});
