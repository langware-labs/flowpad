/**
 * "Your own WhatsApp (scan QR)" in Connect a number: offered only when a placement serves the WhatsApp bridge's
 * admin page, it opens that page (where the phone is paired by QR and the bridge registers the hub webhook).
 *
 * Unit tier, not `react`: the hub chain and the bridge lookup are passed in, so it needs jsdom but no backend.
 */
/* eslint-disable @typescript-eslint/require-await -- the stand-ins answer like the hub client: async */
import '@testing-library/jest-dom/vitest';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { InboundApi, InboundChainBody } from '@sdk';
import { ConnectNumberDialog } from '@src/components/inbound/ConnectNumberDialog';

function recordingApi() {
  const sent: InboundChainBody[] = [];
  const api: InboundApi = {
    mine: async () => [],
    chain: async (body: InboundChainBody) => {
      sent.push(body);
      throw new Error('not expected');
    },
    setTarget: async () => {
      throw new Error('not expected');
    },
    probe: async () => ({ ok: true, hops: [] }),
    remove: async () => undefined,
    here: async () => 'inst-1',
  };
  return { api, sent };
}

const BRIDGE = '/api/v1/graph/service_endpoint/e1/service/waha-admin/';

describe('ConnectNumberDialog — your own WhatsApp by QR', () => {
  it('opens the deployed bridge to pair by QR, and closes as done without a hub claim of its own', async () => {
    const { api, sent } = recordingApi();
    const opened: string[] = [];
    let done = 0;
    render(
      <ConnectNumberDialog
        open
        onOpenChange={() => {}}
        optionsFor={() => []}
        onDone={() => done++}
        api={api}
        findBridge={async () => BRIDGE}
        openUrl={(url) => opened.push(url)}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('inbound-choice-qr'));
    expect(opened).toEqual([BRIDGE]);
    expect(screen.getByTestId('inbound-pair-step')).toBeInTheDocument();
    await user.click(screen.getByTestId('inbound-pair-reopen'));
    expect(opened).toEqual([BRIDGE, BRIDGE]);
    await user.click(screen.getByTestId('inbound-connect-done'));
    expect(done).toBe(1);
    expect(sent).toEqual([]);
  });

  it('is not offered without a deployed bridge', async () => {
    const { api } = recordingApi();
    let asked = 0;
    render(
      <ConnectNumberDialog
        open
        onOpenChange={() => {}}
        optionsFor={() => []}
        onDone={() => {}}
        api={api}
        findBridge={async () => {
          asked++;
          return '';
        }}
      />,
    );
    await screen.findByTestId('inbound-choice-agent');
    await waitFor(() => expect(asked).toBe(1));
    expect(screen.queryByTestId('inbound-choice-qr')).toBeNull();
  });

  it('is offered for WhatsApp only', async () => {
    const { api } = recordingApi();
    render(
      <ConnectNumberDialog
        open
        onOpenChange={() => {}}
        optionsFor={() => []}
        onDone={() => {}}
        api={api}
        findBridge={async () => BRIDGE}
      />,
    );
    await screen.findByTestId('inbound-choice-qr');
    await userEvent.setup().click(screen.getByTestId('inbound-provider-telegram'));
    expect(screen.queryByTestId('inbound-choice-qr')).toBeNull();
  });
});
