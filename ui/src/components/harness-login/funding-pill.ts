/**
 * The ONE state a status row carries — and it is also what pays.
 *
 * The old modal answered two questions on every assistant row, "signed in?" and (only in the
 * detail view) "what funds it?", and the two could disagree: a signed-in Claude pinned to an
 * OpenRouter key read "Signed in" while the key paid. A row now carries one word, taken from the
 * resolver's verdict first — Plan, API key, LLM Endpoint — and only when nothing funds the
 * harness does its own login decide the word: Signed out, Not checked, Not installed.
 *
 * The pill also names the ACTION its state calls for, so a surface maps one field to a label and
 * a handler instead of re-deriving it from the kind.
 *
 * Pure: no React, no fetch. Every input is a record some hook already holds, so the modal, the
 * footer chip and a test can ask the same question and get the same answer.
 */
import { HubLogin, InstallState, LLMFundingKind, LoginState } from '@sdk';
import type { LLMFundingStatus, StatusRecord } from '@sdk';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { CircleUserRound, Download, Loader2, type LucideIcon } from 'lucide-react';

import { tighterCost, usdLeft, type CostLeft, type CostLeftByEndpoint } from '@src/components/llm-endpoints/usage-math';
import {
  glyphForFundingKind,
  NO_FUNDING_GLYPH,
  SIGNED_OUT_GLYPH,
  type FundingGlyph,
} from '@src/components/llm-sources/llm-source-visuals';
import {
  endpointOf,
  hubFunded,
  hubOffers,
  labelForWorker,
  workerOf,
} from '@src/components/llm-sources/use-llm-sources';
import { harnessStatus } from '@src/components/status/use-status-record';

export type PillKind = 'plan' | 'api_key' | 'hub' | 'signed_out' | 'none' | 'not_installed' | 'signing_in' | 'not_checked';

/** What the row's button does: sign in to the assistant, add a key, or open its sources. */
export type PillAction = 'sign_in' | 'add_key' | 'details';

export interface FundingPill {
  kind: PillKind;
  Icon: LucideIcon;
  /** The pill word. */
  short: MessageDescriptor;
  /** The sentence behind it (tooltip). */
  label: MessageDescriptor;
  action: PillAction;
  /** Dollars left — only for a hub endpoint with a cost cap. The surface words it ("$2.58 left"). */
  usdLeft?: number;
  /** A caveat for the row's small text: the harness is signed out while something else pays. */
  note?: MessageDescriptor;
  /** Backend prose when nothing funds the harness (`funding.blocked[kind]`). */
  title?: string;
}

/** Tone classes per pill kind — one table, so every pill of a kind looks the same. */
export const PILL_TONE: Record<PillKind, string> = {
  plan: 'border-emerald-500/50 text-emerald-500',
  api_key: 'border-emerald-500/50 text-emerald-500',
  hub: 'border-sky-500/50 text-sky-500',
  signed_out: 'border-amber-500/50 text-amber-500',
  none: 'border-amber-500/50 text-amber-500',
  not_installed: 'border-border text-muted-foreground',
  not_checked: 'border-border text-muted-foreground',
  signing_in: 'border-sky-500/50 text-sky-500 animate-pulse',
};

const KIND_TO_PILL: Record<string, PillKind> = {
  [LLMFundingKind.Device]: 'plan',
  [LLMFundingKind.ApiKey]: 'api_key',
  [LLMFundingKind.Hub]: 'hub',
};

/** What a pill needs from a glyph: tone comes from `PILL_TONE`, never from the glyph. */
type Glyph = Pick<FundingGlyph, 'Icon' | 'label' | 'short'>;

const NOT_INSTALLED: Glyph = {
  Icon: Download,
  label: msg`The assistant's CLI is not installed on this machine`,
  short: msg`Not installed`,
};
const NOT_CHECKED: Glyph = {
  Icon: CircleUserRound,
  label: msg`Installed, and no sign-in check has run yet`,
  short: msg`Not checked`,
};
const SIGNING_IN: Glyph = {
  Icon: Loader2,
  label: msg`A sign-in is in progress`,
  short: msg`Signing in…`,
};

export function pillOf(kind: PillKind, g: Glyph, action: PillAction, extra: Partial<FundingPill> = {}): FundingPill {
  return { kind, Icon: g.Icon, short: g.short, label: g.label, action, ...extra };
}

/** The one pill for a harness capability kind. */
export function pillForHarness(
  record: StatusRecord | null | undefined,
  funding: LLMFundingStatus | null | undefined,
  kind: string,
  left: CostLeftByEndpoint = {},
): FundingPill {
  const h = harnessStatus(record, kind);
  const pick = funding?.resolved?.[kind] ?? null;
  const ep = endpointOf(funding, pick ?? undefined);
  const login = h?.login;
  // The harness has an account of its own and is not signed in to it.
  const loginGone = !!h?.has_device_login && (login === LoginState.SignedOut || login === LoginState.Error);
  const blocked = funding?.blocked?.[kind] || undefined;

  if (h?.install === InstallState.NotInstalled) return pillOf('not_installed', NOT_INSTALLED, 'sign_in');
  if (login === LoginState.SigningIn) return pillOf('signing_in', SIGNING_IN, 'details');

  if (pick && ep) {
    const payer = KIND_TO_PILL[ep.kind] ?? 'none';
    return pillOf(payer, glyphForFundingKind(ep.kind), 'details', {
      usdLeft: payer === 'hub' ? usdLeft(left[pick.endpoint_typeid]) : undefined,
      // Something else pays while the harness's own login is gone: the pill says the payer, the
      // small text says the caveat. Two facts, two places, never one word trying to say both.
      note: payer !== 'plan' && loginGone ? msg`signed out` : undefined,
    });
  }

  if (loginGone) return pillOf('signed_out', SIGNED_OUT_GLYPH, 'sign_in', { title: blocked });
  if (login === LoginState.NotChecked) return pillOf('not_checked', NOT_CHECKED, 'sign_in');
  // Nothing pays and there is no login to blame: an account-less harness needs a key; one with
  // an account is offered its sign-in; an unknown harness only has details to show.
  const action: PillAction = !h ? 'details' : h.has_device_login ? 'sign_in' : 'add_key';
  return pillOf('none', NO_FUNDING_GLYPH, action, { title: blocked });
}

/** The FlowPad account's pill per hub login: the kind (tone) and the two strings. */
const HUB_PILL: Record<HubLogin, { kind: PillKind; label: MessageDescriptor; short: MessageDescriptor }> = {
  [HubLogin.SignedIn]: { kind: 'plan', label: msg`Signed in to FlowPad`, short: msg`Signed in` },
  [HubLogin.SigningIn]: { kind: 'signing_in', label: SIGNING_IN.label, short: SIGNING_IN.short },
  [HubLogin.SignedOut]: { kind: 'signed_out', label: msg`Not signed in to FlowPad`, short: msg`Signed out` },
  [HubLogin.Offline]: {
    kind: 'not_checked',
    label: msg`A FlowPad login is stored but the hub has not confirmed it`,
    short: msg`Offline`,
  },
  [HubLogin.Rejected]: {
    kind: 'signed_out',
    label: msg`The hub refused the stored FlowPad login`,
    short: msg`Rejected`,
  },
};

/** The FlowPad row's pill and its small text: who is signed in, and which assistants it funds. */
export function pillForFlowpad(
  record: StatusRecord | null | undefined,
  funding: LLMFundingStatus | null | undefined,
): { pill: FundingPill; email: string; funds: string[] } {
  const hub = record?.hub;
  const login = hub?.login ?? HubLogin.SignedOut;
  const spec = HUB_PILL[login] ?? HUB_PILL[HubLogin.SignedOut];
  const pill = pillOf(
    spec.kind,
    { Icon: login === HubLogin.SigningIn ? Loader2 : CircleUserRound, label: spec.label, short: spec.short },
    login === HubLogin.SignedIn ? 'details' : 'sign_in',
    { title: login === HubLogin.Rejected ? hub?.error || undefined : undefined },
  );
  // The harness's own label from the status record (the backend's "Deep Agents"), falling back
  // to the worker table for a harness the record does not list.
  const funds = hubFunded(funding).map(({ kind }) => harnessStatus(record, kind)?.label || labelForWorker(workerOf(kind)));
  return { pill, email: hub?.email ?? '', funds };
}

export interface KeysSummary {
  count: number;
  total: number;
  /** Providers with a key, each with its masked hint when the store has one. */
  stored: { provider: string; hint: string }[];
  providers: string[];
}

export function keysSummary(record: StatusRecord | null | undefined): KeysSummary {
  const keys = record?.keys ?? [];
  const stored = keys.filter((k) => k.stored).map((k) => ({ provider: k.provider, hint: k.hint ?? '' }));
  return { count: stored.length, total: keys.length, stored, providers: keys.map((k) => k.provider) };
}

export interface EndpointsSummary {
  count: number;
  names: string[];
  /** Dollars left on the tightest cost cap among the endpoints IN USE, when any has one. */
  usdLeft?: number;
}

/** The hub endpoints this account can spend, and what is left on the ones it is spending. */
export function endpointsSummary(
  funding: LLMFundingStatus | null | undefined,
  left: CostLeftByEndpoint = {},
): EndpointsSummary {
  const hubs = hubOffers(funding);
  const tightest = hubFunded(funding).reduce<CostLeft | null>((best, { typeid }) => tighterCost(best, left[typeid]), null);
  return { count: hubs.length, names: hubs.map((e) => e.name), usdLeft: usdLeft(tightest) };
}
