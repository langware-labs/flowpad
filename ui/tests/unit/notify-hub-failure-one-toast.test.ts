/**
 * One hub failure, one toast. A deploy refused by the hub used to show the hub broadcast
 * ("Cloud request rejected") AND the dialog's own "Could not launch the deployment". The caller's
 * toast — which carries the hub's reason — replaces the broadcast; the broadcast stays in the log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

const { toast: sonnerToast } = await import('sonner');
const { notify } = await import('@src/notifications/notify');
const { describeFailedCall } = await import('@sdk/client');

const hubRefusal = {
  isAxiosError: true,
  config: { method: 'post', url: '/api/v1/graph/agent/a/deploy' },
  response: {
    status: 409,
    headers: {},
    data: {
      status: 'FAIL',
      message: 'The hub refused to register this asset: Asset already belongs to a different Project',
      data: { code: 'hub_rejected', error_code: 'hub_rejected', hub_failure: 'rejected', hub_status: 409 },
    },
  },
};

describe('a caller explaining a hub failure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes the generic hub broadcast toast', () => {
    notify.error({ id: 'cloud-request-rejected', title: 'Cloud request rejected', forceToast: true });
    notify.error({ title: 'Could not launch the deployment', error: hubRefusal, forceToast: true });

    expect(sonnerToast.dismiss).toHaveBeenCalledWith('cloud-request-rejected');
  });

  it('leaves the broadcast alone for an error that is not a hub failure', () => {
    notify.error({ title: 'Something else', error: new Error('x'), forceToast: true });

    expect(sonnerToast.dismiss).not.toHaveBeenCalledWith('cloud-request-rejected');
  });

  it('shows the publish code as the error code', () => {
    expect(describeFailedCall(hubRefusal)?.response.errorCode).toBe('hub_rejected');
  });
});
