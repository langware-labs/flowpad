/**
 * The API endpoint half of the endpoint dialog's draft: what a root serves, where its key goes, what
 * a call costs, and which paths pass — and the round trip to the hub's JSON.
 *
 * An API endpoint is edited in the SAME dialog as an LLM endpoint (`LlmEndpointDialog`), on the same
 * `EndpointDraft`; the fields an LLM endpoint does not have live under `draft.api`. The key itself is
 * never here: it goes through the `credential` action, as for an LLM root.
 *
 * **Pure — no React.**
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { APIEndpoint, APIEndpointPriceRule, LLMEndpointKind } from '@sdk';
import { EMPTY_LLM_TIERS } from '@sdk';

import type { EndpointDraft } from './endpoint-catalog';
import {
  API_LIMIT_KEYS,
  badNonNegative,
  filtersToForm,
  formToLimits,
  joinLines,
  limitsToForm,
  splitLines,
} from './filters-limits-forms';

/** What a root can be said to serve; anything else is typed (`Other`). */
export const API_KINDS = [
  { id: 'image.generate', label: msg`Images` },
  { id: 'video.generate', label: msg`Video` },
] as const;

/** One price rule as the form holds it. `times` is `field` or `field=default`, comma separated. */
export interface PriceRuleRow {
  path: string;
  usd: string;
  times: string;
}

export interface ApiDraft {
  /** Root only: the kinds it serves, comma separated (`image.generate`). */
  kinds: string;
  /** Root only, create only: the request header the key is written into. */
  header: string;
  /** Root only: how the key is written there (`{value}`, `Bearer {value}`). */
  format: string;
  /** Root only. */
  prices: PriceRuleRow[];
  /** The root's meter as the hub holds it. Only `requests` and `per_call` are edited here. */
  meterKind: string;
  /** Allowed sub paths (globs), one per line. Empty = everything the sources allow. */
  paths: string;
  /** Allowed methods, one per line. Empty = every method. */
  methods: string;
}

export function emptyApiDraft(): ApiDraft {
  return {
    kinds: API_KINDS[0].id,
    header: 'authorization',
    format: 'Bearer {value}',
    prices: [],
    meterKind: 'requests',
    paths: '',
    methods: '',
  };
}

/** A new API endpoint's draft: the shared fields empty, the API ones at their defaults. */
export function emptyApiEndpointDraft(kind: LLMEndpointKind = 'root'): EndpointDraft {
  return {
    kind,
    name: '',
    enabled: true,
    provider: 'openrouter',
    base_url: '',
    source: '',
    filters: filtersToForm(null),
    limits: limitsToForm(null, API_LIMIT_KEYS),
    tiers: { ...EMPTY_LLM_TIERS },
    default_model: null,
    models: '',
    key: '',
    api: emptyApiDraft(),
  };
}

function timesText(rule: APIEndpointPriceRule): string {
  return (rule.times ?? [])
    .map((factor) =>
      factor.default === undefined || factor.default === 1 ? factor.field : `${factor.field}=${factor.default}`,
    )
    .join(', ');
}

export function apiEndpointDraftFrom(entity: APIEndpoint, kind?: LLMEndpointKind | null): EndpointDraft {
  return {
    ...emptyApiEndpointDraft(kind ?? entity.kind),
    id: entity.id,
    name: entity.name ?? '',
    enabled: entity.enabled ?? true,
    base_url: entity.target?.base_url ?? '',
    limits: limitsToForm(entity.apiLimits, API_LIMIT_KEYS),
    api: {
      kinds: (entity.kinds ?? []).join(', '),
      header: entity.target?.inject?.header ?? '',
      format: entity.target?.inject?.format ?? '{value}',
      prices: (entity.meter?.rules ?? []).map((rule) => ({
        path: rule.path,
        usd: String(rule.usd),
        times: timesText(rule),
      })),
      meterKind: entity.meter?.kind ?? 'requests',
      paths: joinLines(entity.apiFilters?.paths_allow),
      methods: joinLines(entity.apiFilters?.methods_allow),
    },
  };
}

export function kindsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((kind) => kind.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** The rows that name a path, as the hub's rules. A row with no path is not a rule. */
export function priceRules(rows: readonly PriceRuleRow[]): APIEndpointPriceRule[] {
  return rows
    .filter((row) => row.path.trim())
    .map((row) => ({
      path: row.path.trim(),
      usd: Number(row.usd.trim() || '0'),
      times: row.times
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [field, fallback] = part.split('=').map((s) => s.trim());
          return fallback !== undefined && fallback !== '' ? { field, default: Number(fallback) } : { field };
        }),
    }));
}

export function validateApiEndpointDraft(draft: EndpointDraft): MessageDescriptor[] {
  const problems: MessageDescriptor[] = [];
  const api = draft.api ?? emptyApiDraft();
  if (draft.kind === 'root') {
    if (!draft.id && !/^https:\/\/\S+$/i.test(draft.base_url.trim()))
      problems.push(msg`Base URL must be an https URL.`);
    if (!draft.id && !api.header.trim()) problems.push(msg`Name the header the key is sent in.`);
    if (!draft.id && api.format.split('{value}').length !== 2)
      problems.push(msg`The key format must name the key placeholder exactly once.`);
    const rules = priceRules(api.prices);
    if (rules.some((rule) => !Number.isFinite(rule.usd) || rule.usd < 0))
      problems.push(msg`A price must be a non-negative number.`);
    if (
      rules.some((rule) =>
        (rule.times ?? []).some((f) => !f.field || (f.default !== undefined && !Number.isFinite(f.default))),
      )
    ) {
      problems.push(msg`A price multiplier is a request field, optionally with =default.`);
    }
  } else if (!draft.id && !draft.source) {
    problems.push(msg`Choose the endpoint this one draws from.`);
  }
  if (badNonNegative(draft.limits as Record<string, string>, API_LIMIT_KEYS as readonly string[]).length) {
    problems.push(msg`Limits must be non-negative numbers.`);
  }
  return problems;
}

function apiFilters(api: ApiDraft) {
  return { paths_allow: splitLines(api.paths), methods_allow: splitLines(api.methods).map((m) => m.toUpperCase()) };
}

/**
 * The entity JSON a save sends. Never the key. The target (base URL and where the key goes) is sent
 * on create only: the hub freezes it, because whoever could repoint it could aim the stored key at
 * another host. A meter the form does not edit (`json_usage`) is left as the hub holds it.
 */
export function buildApiEntityJson(draft: EndpointDraft, editing: boolean): Record<string, unknown> {
  const api = draft.api ?? emptyApiDraft();
  const json: Record<string, unknown> = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    filters: apiFilters(api),
    limits: formToLimits(draft.limits, API_LIMIT_KEYS),
  };
  if (draft.kind !== 'root') return json;
  json.kinds = kindsOf(api.kinds);
  if (api.meterKind !== 'json_usage') {
    const rules = priceRules(api.prices);
    json.meter = rules.length ? { kind: 'per_call', rules } : { kind: 'requests', rules: [] };
  }
  if (!editing) {
    json.target = {
      base_url: draft.base_url.trim(),
      inject: { header: api.header.trim().toLowerCase(), format: api.format },
    };
  }
  return json;
}

/** The `allocate` body: what the new endpoint gets; the endpoint it draws from is the URL. */
export function buildApiAllocateBody(draft: EndpointDraft) {
  return {
    name: draft.name.trim(),
    filters: apiFilters(draft.api ?? emptyApiDraft()),
    limits: formToLimits(draft.limits, API_LIMIT_KEYS),
  };
}
