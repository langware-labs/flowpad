/**
 * Opening Credentials re-checks the harness CLIs (`@local/status/refresh`). The hub has no
 * `@local` and no CLIs, so on the hub that call was a 404 on every visit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataContext, RuntimeKind, statusService } from '@sdk';
import { refreshHarnessStatus } from '@src/components/status/use-status-record';

describe('the harness status refresh', () => {
  afterEach(() => {
    dataContext.bootstrapInfo = null as never;
    vi.restoreAllMocks();
  });

  it('is not sent on the hub', () => {
    const refresh = vi.spyOn(statusService, 'refresh').mockResolvedValue(undefined as never);
    dataContext.bootstrapInfo = { runtime: { kind: RuntimeKind.HUB } } as never;

    refreshHarnessStatus();

    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([RuntimeKind.DESKTOP, RuntimeKind.SANDBOX])('is sent on %s', (kind) => {
    const refresh = vi.spyOn(statusService, 'refresh').mockResolvedValue(undefined as never);
    dataContext.bootstrapInfo = { runtime: { kind } } as never;

    refreshHarnessStatus();

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
