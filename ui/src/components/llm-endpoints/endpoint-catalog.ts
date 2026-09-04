import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { LLMChain, LLMEndpoint, LLMEndpointKind, LLMEndpointProvider } from '@sdk';
import { LLM_ENDPOINT_PROVIDERS } from '@sdk';

import {
  badNonNegative,
  MODELS_ALLOW_DEFAULT,
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

/**
 * A base URL must be http(s). This used to be imported from the data-sources
 * `provider-catalog`, which is gone — per-provider validators there became
 * `pattern` rules on the field. This module is the last caller, so the check
 * lives here rather than becoming a shared util with one consumer.
 */
function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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
  /** The brand, as a plain string. A brand name is not translated, and a `MessageDescriptor`
   *  cannot be interpolated into another one without an `i18n` instance this pure module has no
   *  business holding — so key-shape messages name the provider from here. */
  brand: string;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  /** What every key from this provider starts with. `sk-` is OpenAI's and is also a PREFIX of the
   *  other two, so it cannot identify a key on its own — see `keyShapeProblem`. */
  keyPrefix: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'openrouter',
    label: msg`OpenRouter`,
    brand: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api',
    keyPlaceholder: 'sk-or-…',
    keyPrefix: 'sk-or-',
  },
  {
    id: 'anthropic',
    label: msg`Anthropic`,
    brand: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyPlaceholder: 'sk-ant-…',
    keyPrefix: 'sk-ant-',
  },
  {
    id: 'openai',
    label: msg`OpenAI`,
    brand: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    keyPlaceholder: 'sk-…',
    keyPrefix: 'sk-',
  },
];

/** The shortest a real provider key runs. Well under every provider's actual length — this catches
 *  a half-selected paste, not a key one character shy of some exact format. */
const MIN_KEY_LENGTH = 20;

/**
 * What is visibly wrong with this key BEFORE it is sent, or `null` when nothing is.
 *
 * Deliberately a prefix-and-shape check, never a full-format regex. Providers lengthen and re-shape
 * the random part of their keys without notice, so a strict pattern would eventually reject valid
 * keys — a far worse failure than the one it prevents, because the owner cannot argue with it. What
 * IS stable is the prefix each provider brands its keys with, and that is exactly what catches the
 * common mistake: pasting one provider's key into another provider's root.
 *
 * Without this the wrong key stored happily, and the first sign of trouble was a much later
 * "no model is available through this endpoint" from the model probe — a message about the
 * endpoint, describing a problem with the key, at a moment far from the paste that caused it.
 *
 * An empty key is NOT reported here; "you typed nothing" belongs to the caller, which distinguishes
 * an untouched field from a wrong one.
 */
export function keyShapeProblem(provider: string | null | undefined, key: string): MessageDescriptor | null {
  const spec = providerSpec(provider);
  const trimmed = key.trim();
  if (!spec || !trimmed) return null;

  if (/\s/.test(trimmed)) {
    return msg`This key contains a space or line break. It was probably copied along with the text around it.`;
  }
  // Checked BEFORE the expected-prefix rule: OpenAI's `sk-` also prefixes the other two, so an
  // OpenRouter key pasted into an OpenAI root passes that rule and must be caught by this one.
  const foreign = PROVIDERS.find((p) => p.id !== spec.id && p.keyPrefix !== 'sk-' && trimmed.startsWith(p.keyPrefix));
  if (foreign) {
    return msg`That looks like an ${foreign.brand} key. This endpoint calls ${spec.brand}, whose keys start with ${spec.keyPrefix}.`;
  }
  if (!trimmed.startsWith(spec.keyPrefix)) {
    return msg`${spec.brand} keys start with ${spec.keyPrefix} — this one does not.`;
  }
  if (trimmed.length < MIN_KEY_LENGTH) {
    return msg`This key looks cut short. Check the whole value was copied.`;
  }
  return null;
}

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
  /** Chain only: the typeid of the endpoint this one draws from.
   *
   *  One parent, not a list. The hub makes the link a `source_llmendpoint` relationship written
   *  only by `allocate`, which takes a single endpoint to draw from — an ordered fallback list is
   *  no longer expressible, so offering one would be a form that lies. */
  source: string;
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
    source: '',
    // A REAL value, not a placeholder: what the field shows is what the save sends. An endpoint
    // created without touching this is narrowed to the families we actually use, rather than
    // inheriting a 400-model aggregator catalogue by saying nothing.
    filters: { ...filtersToForm(null), models_allow: MODELS_ALLOW_DEFAULT },
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

/**
 * Root ⇔ no source — answered by the CHAIN report, not by the entity.
 *
 * `LLMEndpoint.kind` derives from `sources`, and the hub does not serialize that field: a source is
 * a `source_llmendpoint` EDGE, deliberately not a field, because a client-writable list was
 * authorized against nothing — a create could name any endpoint the caller could merely spend
 * through, hanging an uncapped sibling off a pool. So `entity.kind` answers `root` for EVERY
 * endpoint that has ever existed, and a correctly allocated chain is indistinguishable from a
 * keyless orphan.
 *
 * `chain` resolves the real graph, so its entry hop carries the true answer. Returns `null` while
 * the report has not arrived: a caller shows nothing rather than guessing `root`, which is the
 * wrong guess in exactly the case this exists to fix.
 */
export function kindFromChain(chain: LLMChain | undefined, endpointId: string): LLMEndpointKind | null {
  const hop = chain?.hops.find((h) => h.id === endpointTypeId(endpointId));
  if (!hop) return null;
  return hop.is_root ? 'root' : 'chain';
}

export function draftFrom(entity: LLMEndpoint, kind?: LLMEndpointKind | null): EndpointDraft {
  const provider = isProvider(entity.provider) ? entity.provider : PROVIDERS[0].id;
  return {
    id: entity.id,
    // `entity.kind` is `root` for everything (see `kindFromChain`), which opened the edit form on a
    // chain with provider, base URL and key fields — none of which a chain has. The caller passes
    // the chain-resolved kind when it has one.
    kind: kind ?? entity.kind,
    name: entity.name ?? '',
    enabled: entity.enabled ?? true,
    provider,
    base_url: entity.base_url || providerSpec(provider)?.defaultBaseUrl || '',
    // Only ever read back from a hub that still serialized the field; a current one does not, and
    // the parent is fixed at allocation anyway, so this is display-only on edit.
    source: entity.sources?.[0] ?? '',
    filters: filtersToForm(entity.filters),
    limits: limitsToForm(entity.limits),
    key: '',
  };
}

/**
 * What the form can judge on its own.
 *
 * Cycles and filter-narrowing are NOT checked here any more. Both are properties of the resolved
 * graph, and the client can no longer see one: sources are edges the entity does not serialize. The
 * hub judges them in `allocate` (`validate_child_write`) against the source's own graph, before
 * anything is written, and the dialog surfaces that message verbatim. A client-side check over the
 * endpoints this user happens to see would have been a guess wearing the costume of a guarantee.
 */
export function validateDraft(draft: EndpointDraft): MessageDescriptor[] {
  const problems: MessageDescriptor[] = [];
  if (!draft.name.trim()) problems.push(msg`Name is required.`);

  if (draft.kind === 'root') {
    if (!isProvider(draft.provider)) problems.push(msg`Pick a provider.`);
    if (!isHttpUrl(draft.base_url.trim())) problems.push(msg`Base URL must be an http(s) URL.`);
  } else if (!draft.id && !draft.source) {
    // Create only: the parent is the `allocate` target, so without it there is nothing to POST to.
    // On edit it is immutable and not re-sent, so an absent one is not a problem to report. There is
    // no self-source check because there is no self yet — the entity the parent is chosen for does
    // not exist until `allocate` returns it.
    problems.push(msg`Choose the endpoint this one draws from.`);
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
 *
 * It never carries `sources` either. That field no longer exists on the hub, and an entity create
 * DROPS fields it does not recognise while still answering 200 — so sending it produced a green
 * toast and a keyless root where a chain was asked for. Allocation goes through
 * `buildAllocateBody` and the `allocate` action instead.
 */
export function buildEntityJson(draft: EndpointDraft, editing: boolean): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    filters: formToFilters(draft.filters),
    limits: formToLimits(draft.limits),
  };
  if (draft.kind === 'root' && !editing) {
    json.provider = draft.provider;
    json.base_url = draft.base_url.trim();
  }
  return json;
}

/** The `allocate` body for a chain create: everything the child gets, minus the parent — which is
 *  the URL. `enabled` is not here because a freshly allocated endpoint is enabled. */
export function buildAllocateBody(draft: EndpointDraft): {
  name: string;
  filters: ReturnType<typeof formToFilters>;
  limits: ReturnType<typeof formToLimits>;
} {
  return {
    name: draft.name.trim(),
    filters: formToFilters(draft.filters),
    limits: formToLimits(draft.limits),
  };
}

/**
 * Gating off the hub's own permission expansion.
 *
 * `readOnly` / `canInvite` / `canDelete` THROW when the entity was fetched without
 * `expand: ['permissions']`; the list query always expands them, but an entity reached another way
 * (or a fresh, unsaved one) must not crash the screen — it just gets no admin controls. One guard
 * so the next gate added here cannot forget the try.
 */
function permits(entity: { saved?: boolean } | null | undefined, ask: () => boolean): boolean {
  if (!entity || !entity.saved) return false;
  try {
    return ask();
  } catch {
    return false;
  }
}

export function canConfigure(entity: Pick<LLMEndpoint, 'readOnly' | 'saved'> | null | undefined): boolean {
  return permits(entity, () => !entity!.readOnly);
}

/**
 * Who may hand this budget to someone else.
 *
 * Deliberately NOT `canConfigure`. On an `llm_endpoint` the hub gives `members` to `owner` alone —
 * an `admin` may re-budget it, replace its provider key and allocate from it, and still cannot give
 * it away. `canInvite` asks the hub's own permission expansion for exactly that action, so the
 * button is absent rather than present-and-403 for the admin case.
 */
export function canShare(entity: Pick<LLMEndpoint, 'canInvite' | 'saved'> | null | undefined): boolean {
  return permits(entity, () => entity!.canInvite);
}

export function canRemove(entity: Pick<LLMEndpoint, 'canDelete' | 'saved'> | null | undefined): boolean {
  return permits(entity, () => entity!.canDelete);
}
