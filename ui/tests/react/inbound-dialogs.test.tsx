/* eslint-disable @typescript-eslint/require-await -- the stand-in answers like the hub client: async, without waiting on anything */
import '@testing-library/jest-dom/vitest';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ChannelRouteTarget, InboundApi, InboundChainBody, InboundClaim } from '@sdk';
import { AddRuleDialog } from '@src/components/inbound/AddRuleDialog';
import { ConnectNumberDialog } from '@src/components/inbound/ConnectNumberDialog';
import { RouteCheck } from '@src/components/inbound/RouteCheck';
import type { DestinationOption } from '@src/components/inbound/inbound-model';

const NUMBER: InboundClaim = {
  id: 'n1',
  parent_id: 'root',
  url: 'https://hub.example/api/v1/webhook/n1',
  provider: 'whatsapp',
  status: 'active',
  claim: { kind: 'account', key: '109876' },
  target: { kind: 'none' },
  deliveries: 0,
  misroutes: 0,
  recent: [],
};

const THIS: ChannelRouteTarget = { kind: 'desktop', instance_id: 'inst-1', data_source_id: 'ds-a' };
const OPTIONS: DestinationOption[] = [
  {
    key: 'default',
    label: "Default — the number's fallback",
    detail: '',
    target: { kind: 'none' },
    testId: 'inbound-dest-default',
  },
  {
    key: 'this:ds-a',
    label: 'Sales agent · This computer',
    detail: '',
    target: THIS,
    testId: 'inbound-dest-this-ds-a',
  },
];

/** A recording stand-in for the hub's `webhook` chain: what the dialogs send, and canned answers. */
function recordingApi(overrides: Partial<InboundApi> = {}) {
  const sent: { verb: string; args: unknown[] }[] = [];
  const api: InboundApi = {
    mine: async () => [NUMBER],
    chain: async (body: InboundChainBody) => {
      sent.push({ verb: 'chain', args: [body] });
      return { ...NUMBER, id: 'made', claim: { kind: body.claim.kind, key: body.claim.key ?? '' } };
    },
    setTarget: async (id: string, target: ChannelRouteTarget) => {
      sent.push({ verb: 'setTarget', args: [id, target] });
      return { ...NUMBER, id, target };
    },
    probe: async (id: string) => {
      sent.push({ verb: 'probe', args: [id] });
      return { ok: true, hops: [{ hop: 'claim', ok: true, detail: 'active' }] };
    },
    remove: async () => undefined,
    here: async () => 'inst-1',
    ...overrides,
  };
  return { api, sent };
}

describe('AddRuleDialog', () => {
  it('adds a group rule with the exact chain body', async () => {
    const { api, sent } = recordingApi();
    let done = 0;
    render(
      <AddRuleDialog open onOpenChange={() => {}} number={NUMBER} options={OPTIONS} onDone={() => done++} api={api} />,
    );
    const user = userEvent.setup();
    expect(screen.getByTestId('inbound-rule-kind-keyword')).toBeDisabled();
    await user.click(screen.getByTestId('inbound-rule-kind-group'));
    await user.type(screen.getByTestId('inbound-field-rule-key'), '120363@g.us');
    await user.click(screen.getByTestId('inbound-dest-this-ds-a'));
    await user.click(screen.getByTestId('inbound-rule-save'));
    await waitFor(() => expect(done).toBe(1));
    expect(sent).toEqual([
      { verb: 'chain', args: [{ parent: 'n1', claim: { kind: 'group', key: '120363@g.us' }, target: THIS }] },
    ]);
  });

  it('changes an existing rule with set_target and the default place', async () => {
    const rule: InboundClaim = {
      ...NUMBER,
      id: 'r1',
      parent_id: 'n1',
      claim: { kind: 'user', key: '9725' },
      target: THIS,
    };
    const { api, sent } = recordingApi();
    render(
      <AddRuleDialog
        open
        onOpenChange={() => {}}
        number={NUMBER}
        rule={rule}
        options={OPTIONS}
        onDone={() => {}}
        api={api}
      />,
    );
    const user = userEvent.setup();
    expect(screen.queryByTestId('inbound-field-rule-key')).toBeNull();
    await user.click(screen.getByTestId('inbound-dest-default'));
    await user.click(screen.getByTestId('inbound-rule-save'));
    await waitFor(() => expect(sent).toEqual([{ verb: 'setTarget', args: ['r1', { kind: 'none' }] }]));
  });

  it("shows the hub's refusal", async () => {
    const { api } = recordingApi({
      chain: async () => {
        throw Object.assign(new Error('x'), {
          response: { status: 409, data: { message: 'this user is already claimed by another account' } },
        });
      },
    });
    render(
      <AddRuleDialog open onOpenChange={() => {}} number={NUMBER} options={OPTIONS} onDone={() => {}} api={api} />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByTestId('inbound-field-rule-key'), '9725');
    await user.click(screen.getByTestId('inbound-dest-default'));
    await user.click(screen.getByTestId('inbound-rule-save'));
    expect(await screen.findByTestId('inbound-rule-error')).toHaveTextContent('already claimed by another account');
  });
});

describe('ConnectNumberDialog', () => {
  it('connects a generic Meta-API number with the exact chain body, then shows the URL and verify token', async () => {
    const { api, sent } = recordingApi();
    render(
      <ConnectNumberDialog
        open
        onOpenChange={() => {}}
        optionsFor={() => OPTIONS.slice(1)}
        onDone={() => {}}
        api={api}
      />,
    );
    const user = userEvent.setup();
    expect(screen.getByTestId('inbound-choice-agent')).toHaveTextContent('Flowpad agent');
    expect(screen.getByTestId('inbound-choice-meta')).toHaveTextContent('Meta official Cloud API');
    await user.click(screen.getByTestId('inbound-choice-generic'));
    expect(screen.getByText('What happens')).toBeInTheDocument();
    await user.type(screen.getByTestId('inbound-field-phone-id'), '109876');
    await user.type(screen.getByTestId('inbound-field-token'), 'tok');
    await user.type(screen.getByTestId('inbound-field-graph-url'), 'https://graph.example.com/v23.0');
    await user.type(screen.getByTestId('inbound-field-app-secret'), 'sec');
    await user.type(screen.getByTestId('inbound-field-verify-token'), 'word');
    // On a desktop "This computer" is preselected as the fallback.
    expect(screen.getByTestId('inbound-dest-this-ds-a')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('inbound-connect-submit'));
    expect(await screen.findByTestId('inbound-connected-url')).toHaveTextContent(NUMBER.url);
    expect(screen.getByTestId('inbound-connected-verify-token')).toHaveTextContent('word');
    expect(sent).toEqual([
      {
        verb: 'chain',
        args: [
          {
            parent: '@whatsapp',
            claim: { kind: 'account', key: '109876' },
            proof: {
              credential: 'tok',
              app_secret: 'sec',
              verify_token: 'word',
              graph_url: 'https://graph.example.com/v23.0',
            },
            target: THIS,
          },
        ],
      },
    ]);
  });

  it('links a phone through Flowpad and shows the code', async () => {
    const { api, sent } = recordingApi({
      chain: async (body) => {
        sent.push({ verb: 'chain', args: [body] });
        return { ...NUMBER, id: 'p1', status: 'pending', claim: { kind: 'user', key: '' }, code: 'K4Q9ZD' };
      },
    });
    render(<ConnectNumberDialog open onOpenChange={() => {}} optionsFor={() => []} onDone={() => {}} api={api} />);
    await userEvent.setup().click(screen.getByTestId('inbound-choice-agent'));
    expect(await screen.findByTestId('inbound-link-code')).toHaveTextContent('K4Q9ZD');
    expect(sent).toEqual([{ verb: 'chain', args: [{ parent: '@whatsapp', claim: { kind: 'user' } }] }]);
  });
});

describe('RouteCheck', () => {
  it('probes every rule and the fallback with phase reach, and marks an offline place', async () => {
    const rule: InboundClaim = {
      ...NUMBER,
      id: 'r1',
      parent_id: 'n1',
      claim: { kind: 'user', key: '9725' },
      misroutes: 3,
    };
    const { api, sent } = recordingApi({
      probe: async (id) => {
        sent.push({ verb: 'probe', args: [id] });
        return id === 'r1'
          ? { ok: false, hops: [{ hop: 'target', ok: false, detail: 'desktop inst-2 not connected' }] }
          : { ok: true, hops: [{ hop: 'claim', ok: true, detail: 'active' }] };
      },
    });
    render(
      <RouteCheck
        open
        onOpenChange={() => {}}
        number={{ claim: NUMBER, rules: [rule], fallback: NUMBER.target }}
        api={api}
      />,
    );
    expect(await screen.findByTestId('inbound-route-offline-r1')).toBeInTheDocument();
    expect(screen.getByTestId('inbound-route-misroute-r1')).toBeInTheDocument();
    expect(screen.getByTestId('inbound-route-n1')).toHaveAttribute('data-ok', 'true');
    expect(sent.map((s) => s.args[0]).sort()).toEqual(['n1', 'r1']);
  });
});
