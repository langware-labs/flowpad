/**
 * `funding-pill` — the ONE word a status row carries, and the rule that picks it.
 *
 * The rule under test: the resolver's verdict names the word (Plan / API key / LLM Endpoint);
 * only when nothing funds the harness does its own login speak (Signed out / Not checked /
 * Not installed). A signed-out harness that a key still pays for reads "API key" with a
 * "signed out" note — never "Signed in" beside "Plan", the double answer the old modal gave.
 */
import { describe, expect, it } from 'vitest';

import { HubLogin, InstallState, LLMSourceAuthority, LLMSourceOrigin, LoginState } from '@sdk';
import type {
  HarnessStatus,
  LLMChainHop,
  LLMEndpointOffer,
  LLMFundingStatus,
  LLMSource,
  StatusRecord,
} from '@sdk';

import {
  amountLeft,
  endpointsSummary,
  keysSummary,
  pillForFlowpad,
  pillForHarness,
  tightestCostLimit,
} from '@src/components/harness-login/funding-pill';

const KIND = 'harness.claude.cli';
const DEVICE = 'llm_endpoint-00000000-0000-4000-8000-000000000001';
const KEY = 'llm_endpoint-00000000-0000-4000-8000-000000000002';
const HUB = 'llm_endpoint-00000000-0000-4000-8000-000000000003';
const HUB2 = 'llm_endpoint-00000000-0000-4000-8000-000000000004';

function endpoint(typeid: string, kind: string, over: Partial<LLMEndpointOffer> = {}): LLMEndpointOffer {
  return {
    id: typeid.replace('llm_endpoint-', ''),
    name: typeid,
    provider: kind === 'device' ? '' : 'openrouter',
    enabled: true,
    credential_hint: '',
    invoke_path: '',
    kind,
    secret_name: '',
    models: {},
    invocable: kind !== 'device',
    base_url: '',
    filters: {} as LLMEndpointOffer['filters'],
    limits: {} as LLMEndpointOffer['limits'],
    holder_typeid: null,
    ...over,
  } as LLMEndpointOffer;
}

function source(typeid: string, over: Partial<LLMSource> = {}): LLMSource {
  return {
    endpoint_typeid: typeid,
    name: typeid,
    detail: '',
    eligible: true,
    reason: '',
    auto: true,
    authority: LLMSourceAuthority.Cached,
    rank: 0,
    origin: LLMSourceOrigin.Default,
    ...over,
  } as LLMSource;
}

function funding(resolved: string | null, over: Partial<LLMFundingStatus> = {}): LLMFundingStatus {
  return {
    available: [endpoint(HUB, 'hub', { name: 'eran default' }), endpoint(HUB2, 'hub', { name: 'global' })],
    sources: { [KIND]: [] },
    resolved: { [KIND]: resolved ? source(resolved) : null },
    blocked: { [KIND]: resolved ? '' : 'nothing eligible' },
    notes: { [KIND]: '' },
    endpoints: { [DEVICE]: endpoint(DEVICE, 'device'), [KEY]: endpoint(KEY, 'api_key'), [HUB]: endpoint(HUB, 'hub') },
    active_for: [],
    binding: null,
    default: { kind: KIND, installed: true, source: null, reason: '' },
    ...over,
  } as unknown as LLMFundingStatus;
}

function harness(over: Partial<HarnessStatus> = {}): HarnessStatus {
  return {
    kind: KIND,
    worker_type: 'claude',
    label: 'Claude',
    icon: 'Bot',
    install: InstallState.Installed,
    version: '',
    path: '',
    login: LoginState.SignedIn,
    login_checked_at: '',
    login_message: '',
    account: { identity: 'eran@langware.ai', plan: 'max' },
    has_device_login: true,
    key_providers: ['openrouter'],
    install_command: '',
    homepage_url: '',
    ...over,
  };
}

function record(h: HarnessStatus, over: Partial<StatusRecord> = {}): StatusRecord {
  return {
    harnesses: [h],
    keys: [
      { provider: 'openrouter', stored: true, created_at: '', hint: '****ab12' },
      { provider: 'anthropic', stored: false, created_at: '', hint: '' },
      { provider: 'openai', stored: false, created_at: '', hint: '' },
    ],
    hub: { login: HubLogin.SignedIn, email: 'eran@langware.ai', user_typeid: 'user-1', error: '' },
    default_harness: KIND,
    ...over,
  } as StatusRecord;
}

function hop(remaining: LLMChainHop['remaining']): LLMChainHop {
  return { id: 'x', name: 'x', provider: null, is_root: false, has_credential: true, enabled: true, breaker: { state: 'closed', open_until: null }, limits: {} as LLMChainHop['limits'], remaining, effective_filters: {} as LLMChainHop['effective_filters'] };
}

describe('pillForHarness', () => {
  it('a signed-in harness funded by its plan reads Plan, with no note', () => {
    const pill = pillForHarness(record(harness()), funding(DEVICE), KIND);
    expect(pill.kind).toBe('plan');
    expect(pill.note).toBeUndefined();
  });

  it('a key-funded harness that is signed out reads API key and notes the sign-out', () => {
    const pill = pillForHarness(record(harness({ login: LoginState.SignedOut })), funding(KEY), KIND);
    expect(pill.kind).toBe('api_key');
    expect(pill.note).toBeDefined();
  });

  it('a hub-funded harness carries what is left on that endpoint', () => {
    const pill = pillForHarness(record(harness({ login: LoginState.SignedOut })), funding(HUB), KIND, {
      [HUB]: { limit: 3, used: 0.42, remaining: 2.58, window: 'total', key: 'cost_usd_total', resets_at: null },
    });
    expect(pill.kind).toBe('hub');
    expect(pill.amount).toBe('$2.58 left');
  });

  it('a hub-funded harness with no cost cap carries no amount', () => {
    const pill = pillForHarness(record(harness()), funding(HUB), KIND, { [HUB]: null });
    expect(pill.kind).toBe('hub');
    expect(pill.amount).toBeUndefined();
  });

  it('nothing funds it and the login is gone: Signed out, with the backend reason as title', () => {
    const pill = pillForHarness(record(harness({ login: LoginState.SignedOut })), funding(null), KIND);
    expect(pill.kind).toBe('signed_out');
    expect(pill.title).toBe('nothing eligible');
  });

  it('a not-installed CLI is Not installed whatever the funding record says', () => {
    const pill = pillForHarness(record(harness({ install: InstallState.NotInstalled, login: LoginState.NA })), funding(DEVICE), KIND);
    expect(pill.kind).toBe('not_installed');
  });

  it('an unprobed login is Not checked, never presumed signed in', () => {
    const pill = pillForHarness(record(harness({ login: LoginState.NotChecked })), funding(null), KIND);
    expect(pill.kind).toBe('not_checked');
  });

  it('a signing-in harness pulses', () => {
    const pill = pillForHarness(record(harness({ login: LoginState.SigningIn })), funding(null), KIND);
    expect(pill.kind).toBe('signing_in');
  });

  it('a key-only harness (no device login) with nothing stored reads No source', () => {
    const pill = pillForHarness(record(harness({ has_device_login: false, login: LoginState.NA })), funding(null), KIND);
    expect(pill.kind).toBe('none');
  });
});

describe('tightestCostLimit / amountLeft', () => {
  it('picks the smallest remaining cost cap across hops and ignores token caps', () => {
    const r = tightestCostLimit([
      hop({ tokens_per_day: { limit: 1000, used: 999, remaining: 1, window: 'day', resets_at: null } }),
      hop({
        cost_usd_per_day: { limit: 5, used: 1, remaining: 4, window: 'day', resets_at: null },
        cost_usd_total: { limit: 3, used: 0.42, remaining: 2.58, window: 'total', key: 'cost_usd_total', resets_at: null },
      }),
    ]);
    expect(r?.remaining).toBe(2.58);
    expect(amountLeft(r)).toBe('$2.58 left');
  });

  it('no cost cap anywhere → null, and no amount', () => {
    expect(tightestCostLimit([hop({})])).toBeNull();
    expect(amountLeft(null)).toBeUndefined();
  });
});

describe('pillForFlowpad', () => {
  it('signed in: email and the assistants its endpoints fund', () => {
    const { pill, email, funds } = pillForFlowpad(record(harness()), funding(HUB));
    expect(pill.kind).toBe('plan');
    expect(email).toBe('eran@langware.ai');
    expect(funds).toEqual(['Claude']);
  });

  it('signed out: Signed out and nothing funded', () => {
    const rec = record(harness(), { hub: { login: HubLogin.SignedOut, email: '', user_typeid: '', error: '' } });
    const { pill, funds } = pillForFlowpad(rec, funding(DEVICE));
    expect(pill.kind).toBe('signed_out');
    expect(funds).toEqual([]);
  });
});

describe('keysSummary / endpointsSummary', () => {
  it('counts stored keys and carries their hints', () => {
    const s = keysSummary(record(harness()));
    expect(s.count).toBe(1);
    expect(s.total).toBe(3);
    expect(s.stored).toEqual([{ provider: 'openrouter', hint: '****ab12' }]);
  });

  it('counts hub endpoints, those in use, and the tightest amount among the in-use ones', () => {
    const s = endpointsSummary(funding(HUB), {
      [HUB]: { limit: 3, used: 0.42, remaining: 2.58, window: 'total', key: 'cost_usd_total', resets_at: null },
      [HUB2]: { limit: 100, used: 0, remaining: 100, window: 'total', key: 'cost_usd_total', resets_at: null },
    });
    expect(s.count).toBe(2);
    expect(s.inUse).toBe(1);
    expect(s.amount).toBe('$2.58 left');
    expect(s.names).toEqual(['eran default', 'global']);
  });
});
