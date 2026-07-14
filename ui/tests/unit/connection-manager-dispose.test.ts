import { describe, expect, it, vi } from 'vitest';

import { ConnectionManager } from '@sdk/websocket';

describe('ConnectionManager.dispose', () => {
  it('closes its socket and suppresses reconnect for a discarded SDK realm', async () => {
    const manager = new ConnectionManager();
    const close = vi.fn();
    const reconnect = vi.spyOn(manager as any, 'reconnect');
    (manager as any).socket = { close };

    manager.dispose();
    manager.onClose({ code: 1000, wasClean: true, reason: 'disposed' } as CloseEvent);

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(1000, 'connection manager disposed');
    expect(reconnect).not.toHaveBeenCalled();
    await expect(manager.connect()).rejects.toThrow('Connection manager disposed');

    manager.dispose();
    expect(close).toHaveBeenCalledOnce();
  });
});
