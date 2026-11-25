/**
 * A window's older socket closing must not unregister the newer one.
 *
 * After a sleep/wake the page can hold two sockets under ONE connection id for
 * a while: the stale one the backend has not seen close yet, and the one the
 * page redialed. When the stale one finally closes, the backend must clean up
 * after THAT socket only. It used to clean up by connection id, which removed
 * the live socket's registration and parked its terminals: the page stayed
 * "connected", its requests still worked, and nothing was pushed back to it
 * (prod 2026-11-23: a terminal took keystrokes and showed nothing until reload).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { trackForCleanup } from '../_cleanup';
import { ConnectionManager, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { v4 as uuidv4 } from 'uuid';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

interface NavigateBody {
  exit_code: number;
  delivered: boolean;
  connection_id: string | null;
  verdict: string | null;
}

const socketEvent = (ws: WebSocket, name: 'open' | 'close') =>
  new Promise<void>((resolve) => ws.addEventListener(name, () => resolve(), { once: true }));

describe('a superseded socket closing', () => {
  let connectionManager: ConnectionManager;
  let project: Project;
  let stale: WebSocket | null = null;

  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'ws-superseded-socket-close');
    connectionManager = ConnectionManager.getInstance();
    expect(connectionManager.connected).toBe(true);

    const id = uuidv4();
    project = new Project({
      id,
      name: 'Superseded Socket Project',
      uname: `ws-superseded-${id}`,
      visitor_role: 'owner',
    });
    await project.save();
    trackForCleanup(project);
  });

  afterAll(async () => {
    stale?.close();
    await project?.delete();
  });

  /** Ask the backend to push a navigation to this window; `delivered` says whether it could reach it. */
  const pushToThisWindow = () =>
    apiClient.post<NavigateBody>('/agent/navigate/entity', {
      typeid: new TypeId('project', project.id).toString(),
      connection_id: connectionManager.id,
    });

  it('leaves the newer socket of the same connection id reachable', async () => {
    // The stale socket: same connection id, same URL the page itself dialed.
    stale = new WebSocket(connectionManager.getSocket()!.url);
    await socketEvent(stale, 'open');

    // The page redials: its new socket is now the newest one under this id.
    const redialed = new Promise<void>((resolve) => connectionManager.once('on_reconnected', () => resolve()));
    connectionManager.getSocket()!.close();
    await redialed;
    expect(connectionManager.connected).toBe(true);
    expect((await pushToThisWindow()).delivered).toBe(true); // both open: the window is reachable

    // The stale socket finally closes.
    const closed = socketEvent(stale, 'close');
    stale.close();
    await closed;

    const body = await pushToThisWindow();
    expect(connectionManager.connected).toBe(true); // the page still holds an open socket
    expect(body.verdict).not.toBe('no_browser');
    expect(body.delivered).toBe(true);
  });
});
