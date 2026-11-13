/**
 * Where an endpoint is saved: this machine or the hub. The one adapter the endpoint dialog calls,
 * so the form never branches on the destination to save.
 *
 * - **This machine**: a root whose key goes to the local secret store and whose fields go onto its
 *   row (`lmKeysService.saveEndpoint`).
 * - **The hub**: an edit is an entity save; a new chain is `allocate` POSTed to the endpoint it draws
 *   from (the hub authorizes delegation against that budget — see `LlmEndpointDialog`); a new root is
 *   an entity save and THEN `setCredential`, so the key is never part of an entity payload.
 *
 * - **A device login** (a vendor subscription, `kind: device`): an edit of its model sizes and custom
 *   names only (`lmKeysService.saveDeviceEndpoint`). It has no key, provider or limits, and is never
 *   created here — every device-login harness has its row already.
 *
 * Returns what happened rather than notifying: the wording belongs to the dialog.
 */
import {
  LLM_MODEL_SIZES,
  LLMEndpoint,
  dataManager,
  llmEndpointsService,
  lmKeysService,
  type LMApiProvider,
} from '@sdk';

import { errorMessage } from '@src/lib/error-message';

import { buildAllocateBody, buildEntityJson, providerSpec, type EndpointDraft } from './endpoint-catalog';
import { endpointIdFromTypeId } from './llm-endpoints-pointer';
import { invalidateLocalEndpoints } from './local-endpoints';

export type EndpointDestination = 'local' | 'hub' | 'device';

/** What a device-login save needs beside the draft's sizes: whose login, and its custom names. */
export interface DeviceDraftFields {
  harness: string;
  /** Custom named model → slug (any name that is not a size). */
  custom: Record<string, string>;
}

export type SaveOutcome =
  | 'updated'
  | 'added_local'
  /** Stored on this machine, but the provider refused the key (`message` says why). */
  | 'added_local_key_refused'
  | 'allocated'
  | 'added'
  | 'added_with_key'
  /** The hub endpoint exists; only its key failed (`message` says why). */
  | 'added_key_failed';

export interface SaveResult {
  endpoint: LLMEndpoint;
  outcome: SaveOutcome;
  message?: string;
}

/** The providers a destination can hold a root for. */
export function providersFor<T extends { supportsLocal: boolean }>(
  providers: readonly T[],
  destination: EndpointDestination,
): T[] {
  return providers.filter((p) => destination === 'hub' || p.supportsLocal);
}

/** A draft fit for `destination`: this machine holds roots only, for the providers it supports. */
export function draftFor(draft: EndpointDraft, destination: EndpointDestination): EndpointDraft {
  if (destination !== 'local') return draft;
  const provider = providerSpec(draft.provider)?.supportsLocal ? draft.provider : 'openrouter';
  const spec = providerSpec(provider);
  const base_url = provider === draft.provider ? draft.base_url : (spec?.defaultBaseUrl ?? '');
  return { ...draft, kind: 'root', source: '', provider, base_url };
}

async function saveLocal(draft: EndpointDraft, isEdit: boolean): Promise<SaveResult> {
  const json = buildEntityJson(draft, isEdit);
  const tiers = Object.fromEntries(Object.entries(draft.tiers).filter(([, model]) => !!model)) as Record<
    string,
    string
  >;
  const res = await lmKeysService.saveEndpoint(draft.provider as LMApiProvider, {
    key: draft.key.trim() || undefined,
    config: {
      name: draft.name.trim() || undefined,
      base_url: draft.base_url.trim() || undefined,
      tiers,
      limits: json.limits as Record<string, number | null>,
      filters: json.filters as Record<string, unknown>,
    },
  });
  invalidateLocalEndpoints();
  const endpoint = new LLMEndpoint({ id: res.endpoint_id, name: draft.name.trim(), provider: draft.provider } as never);
  if (isEdit) return { endpoint, outcome: 'updated' };
  return res.valid === false
    ? { endpoint, outcome: 'added_local_key_refused', message: res.message ?? '' }
    : { endpoint, outcome: 'added_local' };
}

async function saveHub(draft: EndpointDraft, editing: LLMEndpoint | null): Promise<SaveResult> {
  const json = buildEntityJson(draft, !!editing);
  if (editing) {
    return { endpoint: await dataManager.save<LLMEndpoint>(editing.typeId, [], json as never), outcome: 'updated' };
  }
  if (draft.kind === 'chain') {
    const endpoint = await llmEndpointsService.allocate(endpointIdFromTypeId(draft.source), buildAllocateBody(draft));
    return { endpoint, outcome: 'allocated' };
  }
  const fresh = new LLMEndpoint(json as never);
  const endpoint = await dataManager.save<LLMEndpoint>(fresh.typeId, [], json as never);
  const id = endpoint?.id ?? fresh.id;
  if (!draft.key.trim() || !id) return { endpoint, outcome: 'added' };
  try {
    await llmEndpointsService.setCredential(id, draft.key.trim());
    return { endpoint, outcome: 'added_with_key' };
  } catch (e) {
    return { endpoint, outcome: 'added_key_failed', message: errorMessage(e, '') };
  }
}

async function saveDevice(
  draft: EndpointDraft & Partial<DeviceDraftFields>,
  editing: LLMEndpoint | null,
): Promise<SaveResult> {
  if (!editing || !draft.harness) throw new Error('a device login is edited, never created');
  const tiers: Record<string, string> = {};
  for (const [name, model] of Object.entries(draft.custom ?? {})) {
    if (name.trim() && model?.trim() && !(LLM_MODEL_SIZES as readonly string[]).includes(name.trim())) {
      tiers[name.trim()] = model.trim();
    }
  }
  for (const size of LLM_MODEL_SIZES) {
    const model = draft.tiers[size]?.trim();
    if (model) tiers[size] = model;
  }
  await lmKeysService.saveDeviceEndpoint(draft.harness, { tiers });
  invalidateLocalEndpoints();
  return { endpoint: editing, outcome: 'updated' };
}

export function saveEndpoint(
  destination: EndpointDestination,
  draft: EndpointDraft & Partial<DeviceDraftFields>,
  editing: LLMEndpoint | null,
): Promise<SaveResult> {
  if (destination === 'device') return saveDevice(draft, editing);
  return destination === 'local' ? saveLocal(draft, !!editing) : saveHub(draft, editing);
}
