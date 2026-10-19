import { describe, expect, it } from 'vitest';

import { type InboundClaim, accountChainBody, inboundTree, linkChainBody, receivedSince, ruleChainBody } from '@sdk';
import {
  type DestinationLabels,
  destinationOptions,
  manualTarget,
  optionFor,
  samePlace,
} from '@src/components/inbound/inbound-model';

const ROOT = 'root-whatsapp';

function claim(
  id: string,
  parent: string,
  kind: 'account' | 'user' | 'group',
  key: string,
  extra: Partial<InboundClaim> = {},
): InboundClaim {
  return {
    id,
    parent_id: parent,
    url: `https://hub/api/v1/webhook/${id}`,
    provider: 'whatsapp',
    status: 'active',
    claim: { kind, key },
    target: { kind: 'none' },
    deliveries: 0,
    misroutes: 0,
    recent: [],
    ...extra,
  };
}

const LABELS: DestinationLabels = {
  defaultLabel: "Default — the number's fallback",
  defaultDetail: 'falls through',
  thisComputer: 'This computer',
  channel: (name) => `channel ${name}`,
  cloudBox: (place) => `Cloud box ${place}`,
};

describe('inboundTree', () => {
  it('groups rules under their number, sender rules before group rules, and keeps the fallback', () => {
    const fallback = { kind: 'desktop' as const, instance_id: 'inst-1', data_source_id: 'ds-a' };
    const number = claim('n1', ROOT, 'account', '109876', { target: fallback });
    const tree = inboundTree([
      claim('g1', 'n1', 'group', '120363@g.us'),
      number,
      claim('u2', 'n1', 'user', '972540000002'),
      claim('u1', 'n1', 'user', '972540000001'),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].claim.id).toBe('n1');
    expect(tree[0].rules.map((r) => r.id)).toEqual(['u1', 'u2', 'g1']);
    expect(tree[0].fallback).toEqual(fallback);
  });

  it('treats a claim whose parent is not the caller own (the vendor root) as a number', () => {
    const tree = inboundTree([claim('n1', ROOT, 'account', 'a'), claim('p1', ROOT, 'user', '', { status: 'pending' })]);
    expect(tree.map((n) => n.claim.id).sort()).toEqual(['n1', 'p1']);
    expect(tree.every((n) => n.rules.length === 0)).toBe(true);
    expect(tree[0].fallback).toEqual({ kind: 'none' });
  });
});

describe('receivedSince', () => {
  it('counts only deliveries at or after the moment the screen opened, across claims', () => {
    const a = claim('a', ROOT, 'account', 'a', {
      recent: [
        { at: 1000, method: 'POST', status: 200 },
        { at: 999, method: 'POST', status: 200 },
      ],
    });
    const b = claim('b', 'a', 'user', 'u', { recent: [{ at: 1500, method: 'POST', status: 200 }] });
    expect(receivedSince(a, 1000)).toBe(1);
    expect(receivedSince([a, b], 1000)).toBe(2);
    expect(receivedSince([a, b], 2000)).toBe(0);
  });
});

describe('chain bodies', () => {
  it('connects a generic Meta-API number with its proof and fallback', () => {
    const target = { kind: 'desktop' as const, instance_id: 'i', data_source_id: 'd' };
    expect(
      accountChainBody({
        provider: 'whatsapp',
        phoneNumberId: ' 109876 ',
        credential: 'tok',
        appSecret: 'sec',
        verifyToken: 'word',
        graphUrl: 'https://graph.example.com/v23.0',
        target,
      }),
    ).toEqual({
      parent: '@whatsapp',
      claim: { kind: 'account', key: '109876' },
      proof: {
        credential: 'tok',
        app_secret: 'sec',
        verify_token: 'word',
        graph_url: 'https://graph.example.com/v23.0',
      },
      target,
    });
  });

  it('leaves out what was not given: no graph URL for Meta itself, no target for "none"', () => {
    expect(
      accountChainBody({ provider: 'whatsapp', phoneNumberId: '1', credential: 't', target: { kind: 'none' } }),
    ).toEqual({ parent: '@whatsapp', claim: { kind: 'account', key: '1' }, proof: { credential: 't' } });
  });

  it('links a phone through Flowpad with a keyless user claim', () => {
    expect(linkChainBody('telegram')).toEqual({ parent: '@telegram', claim: { kind: 'user' } });
  });

  it('adds a rule under the number with its key and place', () => {
    expect(ruleChainBody('n1', 'group', ' g@g.us ', { kind: 'none' })).toEqual({
      parent: 'n1',
      claim: { kind: 'group', key: 'g@g.us' },
      target: { kind: 'none' },
    });
  });
});

describe('destinationOptions', () => {
  const channels = [
    {
      id: 'ds-a',
      name: 'WhatsApp',
      provider: 'whatsapp',
      ownerName: 'Sales agent',
      places: [
        { key: 'this', label: 'This computer' },
        { key: 'dep-1', label: 'production · gcp_vm', node_typeid: 'compute_node-n1' },
      ],
    },
    { id: 'ds-t', name: 'Telegram', provider: 'telegram' },
  ];

  it('lists the default, this computer and each cloud placement of a channel of the same vendor', () => {
    const options = destinationOptions('whatsapp', channels, 'inst-1', LABELS);
    expect(options.map((o) => o.testId)).toEqual([
      'inbound-dest-default',
      'inbound-dest-this-ds-a',
      'inbound-dest-node-dep-1-ds-a',
    ]);
    expect(options[0].target).toEqual({ kind: 'none' });
    expect(options[1].target).toEqual({ kind: 'desktop', instance_id: 'inst-1', data_source_id: 'ds-a' });
    expect(options[1].label).toBe('Sales agent · This computer');
    expect(options[2].target).toEqual({ kind: 'node', node_typeid: 'compute_node-n1', data_source_id: 'ds-a' });
  });

  it('offers no "this computer" on the hub page and no default for a number', () => {
    const options = destinationOptions('whatsapp', channels, null, LABELS, { withDefault: false });
    expect(options.map((o) => o.key)).toEqual(['node:dep-1:ds-a']);
  });

  it('finds the option a claim already points at, by place', () => {
    const options = destinationOptions('whatsapp', channels, 'inst-1', LABELS);
    expect(optionFor({ kind: 'desktop', instance_id: 'inst-1', data_source_id: 'ds-a' }, options)?.key).toBe(
      'this:ds-a',
    );
    expect(optionFor({ kind: 'none' }, options)?.key).toBe('default');
    expect(optionFor({ kind: 'desktop', instance_id: 'other', data_source_id: 'ds-a' }, options)).toBeNull();
  });
});

describe('places', () => {
  it('compares targets as the hub does', () => {
    expect(samePlace({ kind: 'none' }, undefined)).toBe(true);
    expect(
      samePlace(
        { kind: 'node', node_typeid: 'x', data_source_id: 'd' },
        { kind: 'node', node_typeid: 'x', data_source_id: 'd' },
      ),
    ).toBe(true);
    expect(
      samePlace(
        { kind: 'node', node_typeid: 'x', data_source_id: 'd' },
        { kind: 'node', node_typeid: 'y', data_source_id: 'd' },
      ),
    ).toBe(false);
  });

  it('builds a hand-typed place, naming a bare node id as a typeid', () => {
    expect(manualTarget('node', 'abc', 'ds')).toEqual({
      kind: 'node',
      node_typeid: 'compute_node-abc',
      data_source_id: 'ds',
    });
    expect(manualTarget('desktop', 'inst', 'ds')).toEqual({
      kind: 'desktop',
      instance_id: 'inst',
      data_source_id: 'ds',
    });
    expect(manualTarget('desktop', 'inst', '')).toBeNull();
  });
});
