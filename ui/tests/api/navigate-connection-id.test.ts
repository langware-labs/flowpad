/**
 * Test navigate entity with explicit --connection-id flag.
 *
 * Verifies that when POSTing to /api/v1/agent/navigate/entity with a
 * connection_id parameter, the navigation message is routed to the specific
 * WS connection, not the "active" one.
 *
 * The route answers a `NavigateResult` (flow_sdk/core/navigate.py) in the standard envelope:
 * every outcome — shown, no such tab, nothing found — is a 200 whose `exit_code` is the verdict
 * (0 shown, 4 not found); only bad input is an HTTP error. `apiClient` unwraps it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { trackForCleanup } from '../_cleanup';
import { ConnectionManager, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { v4 as uuidv4 } from 'uuid';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/** The `NavigateResult` fields these cases read. */
interface NavigateBody {
  exit_code: number;
  delivered: boolean;
  connection_id: string | null;
  verdict: string | null;
  value: Record<string, unknown> | null;
}

const navigateEntity = (body: { typeid: string; connection_id?: string }) =>
  apiClient.post<NavigateBody>('/agent/navigate/entity', body);

describe('navigate entity with explicit connection_id', () => {
  let connectionManager: ConnectionManager;
  let testProject: Project;
  let testProjectCreated = false;

  beforeAll(async () => {
    // Bootstrap + establish the websocket connection (the strip/agent path the
    // navigate route targets). apiTestSetup calls connectionManager.connect();
    // the bare ConnectionManager.getInstance() does NOT auto-connect.
    await apiTestSetup(getTestSignupInfo(), 'navigate-connection-id');
    connectionManager = ConnectionManager.getInstance();
    expect(connectionManager.connected).toBe(true);

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
    // Tracked as well as deleted below: the afterAll delete is conditional, so tracking is
    // what guarantees the row cannot outlive the run.
    trackForCleanup(testProject);
    testProjectCreated = true;
  });

  afterAll(async () => {
    if (testProjectCreated) await testProject.delete();
  });

  it('should route navigation to the specified connection_id', async () => {
    const typeid = new TypeId('project', testProject.id);

    const body = await navigateEntity({
      typeid: typeid.toString(),
      connection_id: connectionManager.id, // Target this connection
    });

    expect(body.exit_code).toBe(0);
    expect(body.delivered).toBe(true);
    expect(body.connection_id).toBe(connectionManager.id);
    expect(body.value).toMatchObject({ type: 'project', id: testProject.id });
  });

  it('should return CONNECTION_NOT_FOUND for invalid connection_id', async () => {
    const typeid = new TypeId('project', testProject.id);
    const invalidConnectionId = 'conn-invalid-xyz-does-not-exist';

    const body = await navigateEntity({
      typeid: typeid.toString(),
      connection_id: invalidConnectionId,
    });

    expect(body.exit_code).toBe(4);
    expect(body.verdict).toBe('no_browser');
    expect(body.delivered).toBe(false);
  });

  it('should navigate to active tab when connection_id is omitted', async () => {
    const typeid = new TypeId('project', testProject.id);

    // POST without connection_id — should use active tab
    const body = await navigateEntity({
      typeid: typeid.toString(),
    });

    expect(body.exit_code).toBe(0);
    expect(body.delivered).toBe(true);
    expect(body.connection_id).toBeTruthy(); // Should pick the active connection
    expect(body.value).toMatchObject({ type: 'project', id: testProject.id });
  });
});
