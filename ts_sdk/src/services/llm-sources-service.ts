import { lazyAssets, LazyAsset } from '../lazy';
/**
 * The box's funding picture: which `LLMSource`s could pay for each harness, which one wins,
 * and how to choose a different one.
 *
 * Bound to `compute_node/@local` like `lm-keys-service`, and guarded the same way: in hub mode
 * the action does not exist (device logins, stored keys and the endpoint *binding* are all box
 * facts), so this reports an empty picture rather than erroring a screen.
 *
 * `resolved()` deliberately comes FROM THE BACKEND. If a screen computed "first eligible by
 * rank" itself, the resolver would exist twice and could disagree with what actually spawns —
 * exactly the class of drift a stale `login_state` already caused once.
 */
import apiClient from '../client';
import { isHubOnly } from '../utils/hub-runtime';
import type { LLMSource } from '../entities/llm-source';

const ACTION = 'llm-endpoint';

/** What a caller names when picking a source. The identity tuple, nothing else — status is
 *  the backend's to compute, so sending a whole `LLMSource` back would invite it to be stale. */
export interface LLMSourceRef {
  kind: string;
  provider?: string;
  endpoint_typeid?: string;
}

/** One endpoint as the box mirrors it (`LLMEndpoint.to_wire`). */
export interface LLMEndpointOffer {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  credential_hint: string;
  system_default: boolean;
  invoke_path: string;
  /** `LLMFundingKind` — which of the three funding kinds this is. */
  kind: string;
  /** Sod entry naming the stored key. A NAME, never a value; `api_key` kind only. */
  secret_name: string;
  /** `{sm, md, lg, embedding}` model slugs for this credential. */
  models: Record<string, string>;
  /** False for a device login: the backend can never call it. */
  invocable: boolean;
}

export interface LLMFundingStatus {
  /** Every endpoint this user may spend — their allocations AND the catalog-visible global
   *  root, which the access-scoped listing alone would miss. */
  available: LLMEndpointOffer[];
  endpoint_typeid: string | null;
  invoke_url: string | null;
  name: string | null;
  provider: string | null;
  hub_logged_in: boolean;
  /** Per capability kind (`harness.claude.cli`), every source that could fund it. */
  sources: Record<string, LLMSource[]>;
  /** Per capability kind, the one the resolver picks — `null` when nothing can fund it. */
  resolved: Record<string, LLMSource | null>;
  /** The endpoints those verdicts name, by typeid, deduplicated across harnesses. A verdict
   *  mirrors none of the row's fields, so anything renderable (kind, provider, models) is
   *  looked up here. */
  endpoints: Record<string, LLMEndpointOffer>;
  /** Capability kinds whose resolved source IS the bound endpoint. */
  active_for: string[];
}

export class LlmSourcesService {
  private readonly base: string;

  constructor(private readonly nodeTypeId: { type: string; id: string }) {
    this.base = `/graph/${nodeTypeId.type}/${nodeTypeId.id}/${ACTION}`;
  }

  /** The whole funding picture in one read, or `null` where there is no box to ask.
   *
   *  `null` rather than an all-empty record: a success-shaped empty is indistinguishable from a
   *  box that genuinely has nothing, so the screen renders a bare header instead of saying it is
   *  desktop-only — and every field added to `LLMFundingStatus` would have to be mirrored into
   *  that constant forever. */
  status(): Promise<LLMFundingStatus | null> {
    return lazyAssets.load(LazyAsset.LlmFunding, { nodeTypeId: this.nodeTypeId });
  }

  fetchStatus(): Promise<LLMFundingStatus | null> {
    if (isHubOnly()) return Promise.resolve(null);
    return apiClient.get(this.base);
  }

  /**
   * Choose which source funds `harness`.
   *
   * A distinct sub-action, NOT the bare POST: that one means "the hub is binding this box" and
   * answers 409 without a hub login key, so putting a local UI action on it would fail with
   * "box is not logged in to the hub" for a user picking their own OpenRouter key.
   */
  select(harness: string, source: LLMSourceRef): Promise<LLMFundingStatus> {
    return apiClient.post(`${this.base}/select`, { harness, ...source });
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const llmSourcesService = new LlmSourcesService({ type: 'compute_node', id: '@local' });
