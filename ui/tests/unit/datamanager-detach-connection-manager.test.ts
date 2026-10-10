/**
 * `detach_connection_manager` takes back exactly what `attach_connection_manager`
 * registered: after it, the connection manager holds no listener of that
 * DataManager and delivers it nothing.
 *
 * Real `DataManager` against the real `ConnectionManager` singleton — the pair
 * the constructor wires together.
 */
import { DataManager } from '@sdk';
import { ConnectionManager } from '@sdk/websocket';
import { describe, expect, it } from 'vitest';

const EVENTS = [
  'on_open',
  'on_close',
  'on_data_op',
  'on_control_msg',
  'on_oauth_msg',
  'on_pty_output_msg',
  'on_flow_data',
] as const;

const connection = ConnectionManager.getInstance();
const listeners = () => EVENTS.map((event) => connection.listenerCount(event));

describe('DataManager.detach_connection_manager', () => {
  it('removes every listener the constructor attached', () => {
    const before = listeners();

    const dm = new DataManager();
    expect(listeners()).toEqual(before.map((count) => count + 1));

    dm.detach_connection_manager(connection);
    expect(listeners()).toEqual(before);
  });

  it('stops delivering connection events to the detached manager', () => {
    const dm = new DataManager();
    let delivered = 0;
    dm.on('on_oauth_msg', () => delivered++);

    connection.emit('on_oauth_msg', {});
    expect(delivered).toBe(1);

    dm.detach_connection_manager(connection);
    connection.emit('on_oauth_msg', {});
    expect(delivered).toBe(1);
  });

  it('attaches a connection manager once, however often it is asked to', () => {
    const before = listeners();
    const dm = new DataManager();

    dm.attach_connection_manager(connection);
    expect(listeners()).toEqual(before.map((count) => count + 1));

    dm.detach_connection_manager(connection);
    dm.detach_connection_manager(connection);
    expect(listeners()).toEqual(before);
  });
});
