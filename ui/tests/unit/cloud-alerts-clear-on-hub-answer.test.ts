/**
 * A cloud alert clears when the hub ANSWERS what raised it — the same request, or the
 * connection — and stays up for anything that never got an answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudManager, ContextEventType, dataContext } from '@sdk';

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

const { useAlertStore } = await import('@src/notifications/alerts-store');
const { initNotificationIngest } = await import('@src/notifications/ingest');

const shown = (id: string) => useAlertStore.getState().alerts.some((a) => a.id === id);
const failed = (path: string, status_code: number) =>
  cloudManager.emit('hub_client_error', { method: 'GET', path, status_code, message: 'boom' });
const answered = (path: string) => cloudManager.emit('hub_client_recovered', { method: 'GET', path });

describe('cloud alerts clear on a hub answer', () => {
  let stop: () => void;
  beforeEach(() => {
    useAlertStore.getState().dismissAll();
    stop = initNotificationIngest();
  });
  afterEach(() => stop());

  it('an unreachable cloud raises no warning', () => {
    failed('/api/v1/graph/llm_endpoint', 0);
    expect(shown('cloud-unreachable')).toBe(false);
  });

  it('is not cleared by an answer to some other request', () => {
    failed('/api/v1/graph/api_endpoint', 502);
    answered('/api/v1/graph/llm_endpoint');
    expect(shown('cloud-server-error')).toBe(true);
  });

});

describe('the last hub error', () => {
  it('is cleared when the hub answers that same request, and only that one', () => {
    const cm = cloudManager as unknown as {
      _onHubClientError(m: Record<string, unknown>): void;
      _onHubClientRecovered(m: Record<string, unknown>): void;
    };
    cm._onHubClientError({ method: 'GET', path: '/api/v1/graph/conversation', status_code: 0, message: 'x' });

    cm._onHubClientRecovered({ method: 'GET', path: '/api/v1/graph/llm_endpoint' });
    expect(cloudManager.lastHubError?.path).toBe('/api/v1/graph/conversation');

    cm._onHubClientRecovered({ method: 'GET', path: '/api/v1/graph/conversation' });
    expect(cloudManager.lastHubError).toBeNull();
  });
});

describe('the cloud connection status', () => {
  it('tells context readers it changed, so a reconnect clears "Cloud Connection Lost"', () => {
    const changed = vi.fn();
    dataContext.on(ContextEventType.CONTEXT_CHANGED, changed);
    dataContext.setCloudConnectionStatus('disconnected');
    dataContext.setCloudConnectionStatus('connected');
    dataContext.off(ContextEventType.CONTEXT_CHANGED, changed);
    expect(changed).toHaveBeenCalled();
  });
});
