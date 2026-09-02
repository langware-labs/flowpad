import { afterEach, describe, expect, it, vi } from 'vitest';

import { dataManager } from '@sdk/index';
import { OauthFlow, OAuthEventType, OAuthService, OAuthStatus } from '@sdk/services/oauth/oauth-service';
import type { OAuthWindow } from '@sdk/services/oauth/oauth-window';
import { connectionManager } from '@sdk/websocket';

const TARGET = { type: 'project', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } as never;

class TestWindow implements OAuthWindow {
  private openState = true;

  open(): void {
    this.openState = true;
  }

  close(): void {
    this.openState = false;
  }

  get isOpen(): boolean {
    return this.openState;
  }
}

describe('OAuthService terminal completion', () => {
  const service = OAuthService.getInstance();

  afterEach(() => {
    vi.restoreAllMocks();
    (service as unknown as { oAuthFlows: Map<string, OauthFlow> }).oAuthFlows.clear();
  });

  it('verifies a new grant at owner scope before attaching its target', async () => {
    const test = vi.spyOn(service, 'test').mockResolvedValue({ ok: true });
    const attach = vi.spyOn(service, 'attach').mockResolvedValue(undefined);
    const verifyAndAttach = (
      service as unknown as {
        verifyAndAttach: (
          provider: string,
          target?: typeof TARGET,
          sharedName?: string,
        ) => Promise<{ status: OAuthStatus; attachSuccess: boolean | null }>;
      }
    ).verifyAndAttach.bind(service);

    await expect(verifyAndAttach('slack', TARGET, 'SLACK_TOKEN')).resolves.toEqual({
      status: OAuthStatus.SUCCESS,
      attachSuccess: true,
    });
    expect(test).toHaveBeenCalledWith('slack');
    expect(attach).toHaveBeenCalledWith('slack', TARGET, 'SLACK_TOKEN');
    expect(test.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0]);
  });

  it('always terminates a loopback flow when verification transport rejects', async () => {
    vi.spyOn(service, 'test').mockRejectedValue(new Error('provider unavailable'));
    const emitted = vi.spyOn(dataManager, 'emit');
    const flow = new OauthFlow(
      { provider: 'slack', auth_url: 'https://example.test/auth', oauth_request_id: 'request-1' },
      new TestWindow(),
      TARGET,
    );
    (service as unknown as { oAuthFlows: Map<string, OauthFlow> }).oAuthFlows.set('request-1', flow);

    await service.onOAuthMessage({
      oauth_request_id: 'request-1',
      status: OAuthStatus.SUCCESS,
    } as never);

    expect(emitted).toHaveBeenCalledWith(
      OAuthEventType.OAUTH_FLOW_COMPLETE,
      expect.objectContaining({
        provider: 'slack',
        status: OAuthStatus.ERROR,
        oauth_request_id: 'request-1',
        attachSuccess: null,
      }),
    );
  });

  it('always terminates a device flow when verification transport rejects', async () => {
    vi.spyOn(service, 'test').mockRejectedValue(new Error('provider unavailable'));
    vi.spyOn(dataManager, 'callAction')
      .mockResolvedValueOnce({
        kind: 'device',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://example.test/device',
        state: 'request-2',
      })
      .mockResolvedValueOnce({
        oauth_request_id: 'request-2',
        provider: 'github',
        status: 'pending',
      });
    const emitted = vi.spyOn(dataManager, 'emit');
    let complete:
      | ((message: { auth_method: string; oauth_request_id: string; status: string }) => Promise<void>)
      | undefined;
    vi.spyOn(connectionManager, 'on').mockImplementation((event, listener) => {
      if (event === 'on_llm_config_msg') {
        complete = listener as typeof complete;
      }
      return connectionManager;
    });

    await service.connect('github', TARGET);
    expect(complete).toBeTypeOf('function');
    await complete?.({ auth_method: 'github', oauth_request_id: 'request-2', status: 'success' });

    expect(emitted).toHaveBeenCalledWith(
      OAuthEventType.OAUTH_FLOW_COMPLETE,
      expect.objectContaining({
        provider: 'github',
        status: OAuthStatus.ERROR,
        oauth_request_id: 'request-2',
        attachSuccess: null,
      }),
    );
  });

  it('cancels the exact Hub request when its tracked popup closes', async () => {
    const emitted = vi.spyOn(dataManager, 'emit');
    const waitCallback = vi
      .spyOn(
        service as unknown as {
          waitCallback: OAuthService['test'];
        },
        'waitCallback',
      )
      .mockResolvedValue({
        oauth_request_id: 'request-3',
        provider: 'slack',
        status: 'pending',
      } as never);
    const cancelFlow = vi
      .spyOn(
        service as unknown as {
          cancelFlow: OAuthService['test'];
        },
        'cancelFlow',
      )
      .mockResolvedValue({
        oauth_request_id: 'request-3',
        provider: 'slack',
        status: 'cancelled',
      } as never);
    const flow = new OauthFlow(
      { provider: 'slack', auth_url: 'https://example.test/auth', oauth_request_id: 'request-3' },
      new TestWindow(),
      TARGET,
    );
    flow.closeWindow();

    await (
      service as unknown as {
        driveHubCallback: (
          provider: string,
          info: { provider: string; auth_url: string; oauth_request_id: string },
          flow: OauthFlow,
          target?: typeof TARGET,
        ) => Promise<void>;
      }
    ).driveHubCallback('slack', flow.oAuthRequestInfo, flow, TARGET);

    expect(waitCallback).toHaveBeenCalledWith('slack', 'request-3', TARGET);
    expect(cancelFlow).toHaveBeenCalledWith('slack', 'request-3', TARGET);
    expect(emitted).toHaveBeenCalledWith(
      OAuthEventType.OAUTH_FLOW_COMPLETE,
      expect.objectContaining({
        provider: 'slack',
        status: OAuthStatus.CANCELLED,
        oauth_request_id: 'request-3',
      }),
    );
  });
});
