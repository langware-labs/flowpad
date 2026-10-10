/**
 * The ONE state a status row carries — and it is also what pays.
 *
 * The old modal answered two questions on every assistant row, "signed in?" and (only in the
 * detail view) "what funds it?", and the two could disagree: a signed-in Claude pinned to an
 * OpenRouter key read "Signed in" while the key paid. A row now carries one word, taken from the
 * resolver's verdict first — Plan, API key, LLM Endpoint — and only when nothing funds the
 * harness does its own login decide the word: Signed out, Not checked, Not installed.
 *
 * Pure: no React, no fetch. Every input is a record some hook already holds, so the modal, the
 * footer chip and a test can ask the same question and get the same answer.
 */
import { InstallState, LLMFundingKind, LoginState, HubLogin } from '@sdk';
import type { LLMChainHop, LLMChainRemaining, LLMFundingStatus, StatusRecord } from '@sdk';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { CircleUserRound, Download, Loader2, type LucideIcon } from 'lucide-react';

import { endpointOf, labelForWorker, workerOf } from '@src/components/llm-sources/use-llm-sources';
import { formatAmount, isCostKey } from '@src/components/llm-endpoints/usage-math';
import {
  glyphForFundingKind,
  NO_FUNDING_GLYPH,
  SIGNED_OUT_GLYPH,
  type FundingGlyph,
} from '@src/components/llm-sources/llm-source-visuals';
import { harnessStatus } from '@src/components/status/use-status-record';

export type PillKind = 'plan' | 'api_key' | 'hub' | 'signed_out' | 'none' | 'not_installed' | 'signing_in' | 'not_checked';

export interface FundingPill {
  kind: PillKind;
  Icon: LucideIcon;
  /** The pill word. */
  short: MessageDescriptor;
  /** The sentence behind it (tooltip). */
  label: MessageDescriptor;
  /** "$2.58 left" — only for a hub endpoint with a cost cap. */
  amount?: string;
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

const NOT_INSTALLED: FundingGlyph = {
  Icon: Download,
  className: 'text-muted-foreground',
  label: msg`The assistant's CLI is not installed on this machine`,
  short: msg`Not installed`,
};
const NOT_CHECKED: FundingGlyph = {
  Icon: CircleUserRound,
  className: 'text-muted-foreground',
  label: msg`Installed, and no sign-in check has run yet`,
  short: msg`Not checked`,
};
const SIGNING_IN: FundingGlyph = {
  Icon: Loader2,
  className: 'text-sky-500',
  label: msg`A sign-in is in progress`,
  short: msg`Signing in…`,
};

function ofGlyph(kind: PillKind, g: FundingGlyph, extra: Partial<FundingPill> = {}): FundingPill {
  return { kind, Icon: g.Icon, short: g.short, label: g.label, ...extra };
}

/** One remaining-budget entry, plus WHICH limit it is (`cost_usd_total`...) so a bar can
 *  format it in its own unit. The hub's entry carries the window word, not the key. */
export type CostRemaining = LLMChainRemaining & { key: string };

/** Remaining per hub endpoint typeid, as `useHubRemaining` reports it. */
export type RemainingByEndpoint = Record<string, CostRemaining | null>;

/**
 * The tightest COST cap along a chain: the smallest `remaining` over every hop's cost limits.
 * Tokens caps are ignored on purpose — a pill shows money, and mixing units in one "left" is
 * how a budget reads as $0 when it is 50k tokens.
 */
export function tightestCostLimit(hops: LLMChainHop[] | undefined): CostRemaining | null {
  let best: CostRemaining | null = null;
  for (const hop of hops ?? []) {
    for (const [key, r] of Object.entries(hop.remaining ?? {})) {
      if (!isCostKey(key) || !(r.limit > 0)) continue;
      if (!best || r.remaining < best.remaining) best = { ...r, key };
    }
  }
  return best;
}

/** "$2.58 left", or undefined when the endpoint has no cost cap (or none was read yet). */
export function amountLeft(r: LLMChainRemaining | null | undefined): string | undefined {
  if (!r || !(r.limit > 0)) return undefined;
  return `${formatAmount('cost_usd', Math.max(0, r.remaining))} left`;
}

/** The one pill for a harness capability kind. */
export function pillForHarness(
  record: StatusRecord | null | undefined,
  funding: LLMFundingStatus | null | undefined,
  kind: string,
  remaining: RemainingByEndpoint = {},
): FundingPill {
  const h = harnessStatus(record, kind);
  const pick = funding?.resolved?.[kind] ?? null;
  const ep = endpointOf(funding, pick ?? undefined);
  const login = h?.login;

  if (h?.install === InstallState.NotInstalled) return ofGlyph('not_installed', NOT_INSTALLED);
  if (login === LoginState.SigningIn) return ofGlyph('signing_in', SIGNING_IN);

  if (pick && ep) {
    const kindOfPay = KIND_TO_PILL[ep.kind] ?? 'none';
    const glyph = glyphForFundingKind(ep.kind);
    const extra: Partial<FundingPill> = {};
    if (kindOfPay === 'hub') extra.amount = amountLeft(remaining[pick.endpoint_typeid]);
    // Something else pays while the harness's own login is gone: the pill says the payer, the
    // small text says the caveat. Two facts, two places, never one word trying to say both.
    if (kindOfPay !== 'plan' && h?.has_device_login && (login === LoginState.SignedOut || login === LoginState.Error)) {
      extra.note = msg`signed out`;
    }
    return ofGlyph(kindOfPay, glyph, extra);
  }

  if (h?.has_device_login && (login === LoginState.SignedOut || login === LoginState.Error)) {
    return ofGlyph('signed_out', SIGNED_OUT_GLYPH, { title: funding?.blocked?.[kind] || undefined });
  }
  if (login === LoginState.NotChecked) return ofGlyph('not_checked', NOT_CHECKED);
  return ofGlyph('none', NO_FUNDING_GLYPH, { title: funding?.blocked?.[kind] || undefined });
}

/** The capability kinds whose resolved source is a hub endpoint — what this account pays for. */
export function kindsFundedByHub(funding: LLMFundingStatus | null | undefined): string[] {
  return Object.entries(funding?.resolved ?? {})
    .filter(([, pick]) => !!pick && endpointOf(funding, pick)?.kind === LLMFundingKind.Hub)
    .map(([kind]) => kind);
}

const HUB_SIGNED_IN: FundingGlyph = {
  Icon: CircleUserRound,
  className: 'text-emerald-500',
  label: msg`Signed in to FlowPad`,
  short: msg`Signed in`,
};
const HUB_SIGNED_OUT: FundingGlyph = {
  Icon: CircleUserRound,
  className: 'text-amber-500',
  label: msg`Not signed in to FlowPad`,
  short: msg`Signed out`,
};
const HUB_OFFLINE: FundingGlyph = {
  Icon: CircleUserRound,
  className: 'text-muted-foreground',
  label: msg`A FlowPad login is stored but the hub has not confirmed it`,
  short: msg`Offline`,
};
const HUB_REJECTED: FundingGlyph = {
  Icon: CircleUserRound,
  className: 'text-amber-500',
  label: msg`The hub refused the stored FlowPad login`,
  short: msg`Rejected`,
};

/** The FlowPad row's pill and its small text: who is signed in, and which assistants it funds. */
export function pillForFlowpad(
  record: StatusRecord | null | undefined,
  funding: LLMFundingStatus | null | undefined,
): { pill: FundingPill; email: string; funds: string[] } {
  const hub = record?.hub;
  // The harness's own label from the status record (the backend's "Deep Agents"), falling back
  // to the worker table for a harness the record does not list.
  const funds = kindsFundedByHub(funding).map((k) => harnessStatus(record, k)?.label || labelForWorker(workerOf(k)));
  const email = hub?.email ?? '';
  switch (hub?.login) {
    case HubLogin.SignedIn:
      return { pill: ofGlyph('plan', HUB_SIGNED_IN), email, funds };
    case HubLogin.SigningIn:
      return { pill: ofGlyph('signing_in', SIGNING_IN), email, funds };
    case HubLogin.Offline:
      return { pill: ofGlyph('not_checked', HUB_OFFLINE), email, funds };
    case HubLogin.Rejected:
      return { pill: ofGlyph('signed_out', HUB_REJECTED, { title: hub?.error || undefined }), email, funds };
    default:
      return { pill: ofGlyph('signed_out', HUB_SIGNED_OUT), email, funds };
  }
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
  inUse: number;
  names: string[];
  /** The tightest "$X left" over the endpoints in use, when any has a cost cap. */
  amount?: string;
}

/** The hub endpoints this account can spend, how many are in use, and what is left on them. */
export function endpointsSummary(
  funding: LLMFundingStatus | null | undefined,
  remaining: RemainingByEndpoint = {},
): EndpointsSummary {
  const hubs = (funding?.available ?? []).filter((e) => e.kind === (LLMFundingKind.Hub as string));
  const inUse = new Set(
    Object.values(funding?.resolved ?? {})
      .filter((pick): pick is NonNullable<typeof pick> => !!pick && endpointOf(funding, pick)?.kind === LLMFundingKind.Hub)
      .map((pick) => pick.endpoint_typeid),
  );
  let tightest: CostRemaining | null = null;
  for (const typeid of inUse) {
    const r = remaining[typeid];
    if (r && r.limit > 0 && (!tightest || r.remaining < tightest.remaining)) tightest = r;
  }
  return { count: hubs.length, inUse: inUse.size, names: hubs.map((e) => e.name), amount: amountLeft(tightest) };
}
