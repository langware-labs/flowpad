import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { LLMEndpoint, LLMEndpointKind, LLMEndpointProvider } from '@sdk';
import { LLM_ENDPOINT_PROVIDERS } from '@sdk';

import {
  badNonNegative,
  filtersToForm,
  formToFilters,
  formToLimits,
  LIMIT_KEYS,
  limitsToForm,
  NUMERIC_FILTER_KEYS,
  STREAMING_POLICIES,
  type FiltersForm,
  type LimitsForm,
} from './filters-limits-forms';
import { endpointTypeId } from './llm-endpoints-pointer';

export { ENDPOINT_TYPE, endpointIdFromTypeId, endpointTypeId } from './llm-endpoints-pointer';

/**
 * The endpoint dialog's vocabulary and rules, as values and pure functions.
 *
 * **Hardcoded provider list, deliberately.** The hub's `LLMProvider` enum has
 * three members and no listing endpoint; a form needs a label, a default
 * `base_url` and a key placeholder per provider — none of which the hub ships.
 * Mirrors `flowpad/hub/core/llm/providers.py` dialect defaults.
 *
 * **Pure — no React, no SDK calls.** The traps (cycles, self-sourcing, a key
 * leaking into an entity payload) are all unit-testable without rendering.
 */

export interface ProviderSpec {
  id: LLMEndpointProvider;
  label: MessageDescriptor;
  defaultBaseUrl: string;
  keyPlaceholder: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  { id: 'openrouter', label: msg`OpenRouter`, defaultBaseUrl: 'https://openrouter.ai/api', keyPlaceholder: 'sk-or-…' },
  { id: 'anthropic', label: msg`Anthropic`, defaultBaseUrl: 'https://api.anthropic.com', keyPlaceholder: 'sk-ant-…' },
  { id: 'openai', label: msg`OpenAI`, defaultBaseUrl: 'https://api.openai.com', keyPlaceholder: 'sk-…' },
];

export function providerSpec(id: string | undefined | null): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isProvider(value: string): value is LLMEndpointProvider {
  return (LLM_ENDPOINT_PROVIDERS as readonly string[]).includes(value);
}

export interface EndpointDraft {
  /** Set when editing — the endpoint's uuid. */
  id?: string;
  kind: LLMEndpointKind;
  name: string;
  enabled: boolean;
  /** Root only. */
  provider: LLMEndpointProvider;
  /** Root only. */
  base_url: string;
  /** Chain only: ordered source typeids. */
  sources: string[];
  filters: FiltersForm;
  limits: LimitsForm;
  /** Root only, create only; NEVER part of the entity payload. */
  key: string;
}

export function emptyDraft(kind: LLMEndpointKind = 'root'): EndpointDraft {
  const provider = PROVIDERS[0];
  return {
    kind,
    name: '',
    enabled: true,
    provider: provider.id,
    base_url: provider.defaultBaseUrl,
    sources: [],
    filters: filtersToForm(null),
    limits: limitsToForm(null),
    key: '',
  };
}

/** Switch a draft's provider, refreshing the base_url when it was still the
 *  previous provider's default (a hand-edited URL is kept). */
export function withProvider(draft: EndpointDraft, provider: LLMEndpointProvider): EndpointDraft {
  const prev = providerSpec(draft.provider);
  const next = providerSpec(provider);
  const keepUrl = draft.base_url.trim() !== '' && draft.base_url !== prev?.defaultBaseUrl;
  return { ...draft, provider, base_url: keepUrl ? draft.base_url : (next?.defaultBaseUrl ?? '') };
}

export function draftFrom(entity: LLMEndpoint): EndpointDraft {
  const provider = isProvider(entity.provider) ? entity.provider : PROVIDERS[0].id;
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name ?? '',
    enabled: entity.enabled ?? true,
    provider,
    base_url: entity.base_url || providerSpec(provider)?.defaultBaseUrl || '',
    sources: [...(entity.sources ?? [])],
    filters: filtersToForm(entity.filters),
    limits: limitsToForm(entity.limits),
    key: '',
  };
}

const HTTP_URL = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/**
 * Does adding `sources` to `selfTypeId` create a cycle in the graph made of
 * `all`'s `sources` edges? Follows edges from each proposed source; reaching
 * self means a loop.
 */
export function wouldCycle(
  selfTypeId: string | undefined,
  sources: readonly string[],
  all: readonly Pick<LLMEndpoint, 'id' | 'sources'>[],
): boolean {
  if (!selfTypeId) return false;
  const edges = new Map<string, readonly string[]>();
  for (const e of all) edges.set(endpointTypeId(e.id), e.sources ?? []);
  const seen = new Set<string>();
  const stack = [...sources];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === selfTypeId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/** Problems with a draft, as message descriptors (the dialog renders them
 *  through `t`). Empty means submittable. */
export function validateDraft(
  draft: EndpointDraft,
  all: readonly Pick<LLMEndpoint, 'id' | 'sources'>[],
): MessageDescriptor[] {
  const problems: MessageDescriptor[] = [];
  if (!draft.name.trim()) problems.push(msg`Name is required.`);

  if (draft.kind === 'root') {
    if (!isProvider(draft.provider)) problems.push(msg`Pick a provider.`);
    if (!HTTP_URL.test(draft.base_url.trim())) problems.push(msg`Base URL must be an http(s) URL.`);
  } else {
    const selfTypeId = draft.id ? endpointTypeId(draft.id) : undefined;
    if (draft.sources.length === 0) problems.push(msg`A chain needs at least one source.`);
    if (selfTypeId && draft.sources.includes(selfTypeId)) problems.push(msg`An endpoint cannot source itself.`);
    else if (wouldCycle(selfTypeId, draft.sources, all)) problems.push(msg`These sources would form a cycle.`);
    if (new Set(draft.sources).size !== draft.sources.length) problems.push(msg`Each source may appear once.`);
  }

  if (badNonNegative(draft.filters, NUMERIC_FILTER_KEYS).length) {
    problems.push(msg`Filter ceilings must be non-negative numbers.`);
  }
  if (!STREAMING_POLICIES.includes(draft.filters.streaming))
    problems.push(msg`Streaming must be allow, require or deny.`);
  if (badNonNegative(draft.limits, LIMIT_KEYS).length) problems.push(msg`Limits must be non-negative numbers.`);
  return problems;
}

/**
 * The entity JSON a save sends. NEVER includes the key (that goes through the
 * `credential` action, write-only), and when `editing` omits the immutable
 * `provider`/`base_url` so an unchanged echo cannot trip the hub's immutability
 * guard. A chain never carries provider/base_url at all.
 */
export function buildEntityJson(draft: EndpointDraft, editing: boolean): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    sources: draft.kind === 'chain' ? [...draft.sources] : [],
    filters: formToFilters(draft.filters),
    limits: formToLimits(draft.limits),
  };
  if (draft.kind === 'root' && !editing) {
    json.provider = draft.provider;
    json.base_url = draft.base_url.trim();
  }
  return json;
}

/**
 * Admin gating off the hub's permission expansion. `readOnly`/`canDelete`
 * THROW when the entity was fetched without `expand: ['permissions']`; the
 * list query always expands them, but an entity reached another way (or a
 * fresh, unsaved one) must not crash the screen — it just gets no admin
 * controls.
 */
export function canConfigure(entity: Pick<LLMEndpoint, 'readOnly' | 'saved'> | null | undefined): boolean {
  if (!entity || !entity.saved) return false;
  try {
    return !entity.readOnly;
  } catch {
    return false;
  }
}

export function canRemove(entity: Pick<LLMEndpoint, 'canDelete' | 'saved'> | null | undefined): boolean {
  if (!entity || !entity.saved) return false;
  try {
    return entity.canDelete;
  } catch {
    return false;
  }
}
