/**
 * Test navigate entity with explicit --connection-id flag.
 *
 * Verifies that when POSTing to /api/v1/agent/navigate/entity with a
 * connection_id parameter, the navigation message is routed to the specific
 * WS connection, not the "active" one.
 *
 * NOTE: /api/v1/agent/navigate/entity is an AGENT/CLI route (`flow navigate
 * entity`). It deliberately returns a FLAT `{ok, connection_id, type, id}` /
 * `{ok:false, error_code, error}` shape (NOT the standard `{status,data}`
 * envelope) so the CLI can map it straight to exit codes — see
 * flow_sdk/cli/commands/navigate_cmd.py, which calls it with `requests.post`.
 * So this test drives it the same way the agent does: a RAW axios client that
 * does not unwrap the envelope (the default `apiClient` interceptor returns
 * `response.data.data`, which is undefined for this flat route).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConnectionManager, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import axios, { type AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('navigate entity with explicit connection_id', () => {
  let connectionManager: ConnectionManager;
  let testProject: Project;
  let testProjectCreated = false;
  // Raw client (no envelope unwrap) — the agent route returns a flat body.
  let raw: AxiosInstance;

  beforeAll(async () => {
    // Bootstrap + establish the websocket connection (the strip/agent path the
    // navigate route targets). apiTestSetup calls connectionManager.connect();
    // the bare ConnectionManager.getInstance() does NOT auto-connect.
    await apiTestSetup(getTestSignupInfo(), 'navigate-connection-id');
    connectionManager = ConnectionManager.getInstance();
    expect(connectionManager.connected).toBe(true);

    // Same backend base URL as apiClient (already includes /api/v1), but without
    // the unwrapping interceptor and accepting all statuses so we can assert on
    // the flat agent contract directly.
    raw = axios.create({
      baseURL: apiClient.defaults.baseURL,
      withCredentials: true,
      validateStatus: () => true,
    });

    // Create a test project for navigation. id must be a valid identifier
    // (UUID); uname is stored WITHOUT a leading '@' — the `identifier` getter
    // adds it (a '@nav-test' uname would derive a '@@nav-test' typeId).
    const projectId = uuidv4();
    testProject = new Project({
      id: projectId,
      name: 'Navigation Test Project',
      uname: `nav-test-${projectId}`,
      visitor_role: 'owner',
    });

    await testProject.save();
    testProjectCreated = true;
  });

  afterAll(async () => {
    if (testProjectCreated) await testProject.delete();
  });

  it('should route navigation to the specified connection_id', async () => {
    const typeid = new TypeId('project', testProject.id);

    const response = await raw.post('/agent/navigate/entity', {
      typeid: typeid.toString(),
      connection_id: connectionManager.id, // Target this connection
    });

    expect(response.status).toBe(200);
    const body = response.data;
    expect(body.ok).toBe(true);
    expect(body.connection_id).toBe(connectionManager.id);
    expect(body.type).toBe('project');
    expect(body.id).toBe(testProject.id);
  });

  it('should return CONNECTION_NOT_FOUND for invalid connection_id', async () => {
    const typeid = new TypeId('project', testProject.id);
    const invalidConnectionId = 'conn-invalid-xyz-does-not-exist';

    const response = await raw.post('/agent/navigate/entity', {
      typeid: typeid.toString(),
      connection_id: invalidConnectionId,
    });

    expect(response.status).toBe(404);
    const body = response.data;
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe('CONNECTION_NOT_FOUND');
  });

  it('should navigate to active tab when connection_id is omitted', async () => {
    const typeid = new TypeId('project', testProject.id);

    // POST without connection_id — should use active tab
    const response = await raw.post('/agent/navigate/entity', {
      typeid: typeid.toString(),
    });

    expect(response.status).toBe(200);
    const body = response.data;
    expect(body.ok).toBe(true);
    expect(body.connection_id).toBeDefined(); // Should pick the active connection
    expect(body.type).toBe('project');
    expect(body.id).toBe(testProject.id);
  });
});
