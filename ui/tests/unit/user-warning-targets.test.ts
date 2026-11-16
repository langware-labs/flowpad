/**
 * Where the OAuth warnings send you.
 *
 * These pointed at `ViewType.CONNECTIONS`, which was retired into a tab of the
 * Credentials view — a view type alone can no longer say "Connections", so the
 * warning has to carry a `targetPointer` too. Without it the click would land
 * on Environment, the default tab, and look like it did nothing.
 */
import { CredentialsSubview, ViewType } from '@sdk';
import {
  createCloudConnectionAuthRejectedWarning,
  createCloudConnectionLostWarning,
  createCloudDisconnectedWarning,
  createCloudLoginFailedWarning,
  createHubRequestFailedWarning,
} from '@sdk/models/UserWarning';
import { describe, it, expect } from 'vitest';

describe('OAuth warning targets', () => {
  it.each([
    ['cloud disconnected', () => createCloudDisconnectedWarning()],
    ['cloud login failed', () => createCloudLoginFailedWarning('nope')],
    ['cloud connection lost', () => createCloudConnectionLostWarning()],
    ['cloud auth rejected', () => createCloudConnectionAuthRejectedWarning()],
    ['hub request failed', () => createHubRequestFailedWarning({ status: 500 })],
  ])('%s opens the Connections tab, not just the view', (_name, make) => {
    const warning = make();

    expect(warning.targetView).toBe(ViewType.CREDENTIALS);
    expect(warning.targetPointer).toBe(CredentialsSubview.CONNECTIONS);
  });
});

describe('a failed hub request warning', () => {
  it('says when it last failed and what to do, so an old one does not read as current', () => {
    const ts = new Date(2026, 10, 13, 23, 35).getTime();
    const { description } = createHubRequestFailedWarning({
      method: 'POST',
      path: '/api/v1/graph/compute_node/abc/ops/status',
      statusCode: 0,
      message: 'ReadTimeout',
      action: 'Check your connection',
      ts,
    });

    expect(description).toContain('POST /api/v1/graph/compute_node/abc/ops/status 0: ReadTimeout');
    expect(description).toMatch(/Last failed \d+.35/);
    expect(description).toMatch(/Check your connection\.$/);
  });
});
