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
import type { LLMEndpointFilters, LLMEndpointLimits } from '../entities/llm-endpoint';
import type { LLMChain, LLMEndpointTestResult } from './llm-endpoints-service';
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
  /** Where the provider is reached. Empty for a hub budget — the hub owns the URL. */
  base_url: string;
  /** What this endpoint lets through: the model allow/deny lists, the ceilings, the
   *  aliases a narrow wallet redirects with. */
  filters: LLMEndpointFilters;
  /** THE budget: the ceilings on this endpoint. `null` = unlimited, `0` = nothing. */
  limits: LLMEndpointLimits;
  /** Whose pot this is — `organization-`/`team-`/`user-<uuid>`, or null for a root or an
   *  allocation. The one field that says whether a budget is a person's own or a pool they
   *  merely draw through, which is what the user-scoped asset view filters on. */
  principal_typeid: string | null;
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
  /** Who the hub thinks this box is (`user-<uuid>`), in the spelling an endpoint's
   *  `principal_typeid` uses — null when signed out. The box's LOCAL user is a different
   *  id entirely, so this is the only way a screen can tell a budget allocated TO this
   *  person from one they merely administer. */
  hub_user_typeid: string | null;
  /** Per capability kind (`harness.claude.cli`), every source the harness HAS — each judged on
   *  its own credential alone. This is the list to choose FROM, so a row is ineligible here only
   *  when the row itself is unusable (signed out, no key stored), never because another source is
   *  currently selected. Do NOT derive "in use" from `auto` here; read `resolved`. */
  sources: Record<string, LLMSource[]>;
  /** Per capability kind, the one the resolver picks — `null` when nothing can fund it. This is
   *  the overlaid answer, the same one a spawn gets. */
  resolved: Record<string, LLMSource | null>;
  /** Per capability kind, why nothing funds it — `''` when something does. `sources` no longer
   *  carries the resolver's overlay, so this is the only place a stuck harness explains itself. */
  blocked: Record<string, string>;
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
  status(projectId?: string): Promise<LLMFundingStatus | null> {
    return lazyAssets.load(LazyAsset.LlmFunding, { nodeTypeId: this.nodeTypeId, projectId });
  }

  /**
   * `projectId` narrows `resolved` to the verdict a spawn IN THAT PROJECT gets.
   *
   * A project may pin an endpoint (`Project.llm_endpoint_typeid`), and that pin outranks the
   * user's own preference. Asked without one the backend answers the box-wide question and a
   * pin is simply invisible — which is what it always did, and why the picker could report a
   * different source than the one a process actually spent. `sources` is unaffected: an offer
   * is judged on its own credential, never on someone else's constraint.
   */
  fetchStatus(projectId?: string): Promise<LLMFundingStatus | null> {
    if (isHubOnly()) return Promise.resolve(null);
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return apiClient.get(`${this.base}${query}`);
  }

  /**
   * Does a call through `endpointId` actually succeed?
   *
   * A pass-through to the hub's own `test` action, and the ONLY route to it from the desktop:
   * `llmEndpointsService.testEndpoint` addresses `/graph/llm_endpoint/<id>/test`, which on a box
   * is a 404 — the type has no local rows (`flow_sdk/builtin/llm_endpoint.py`). Same channel the
   * listing already rides, so a screen never has to know which of the two it is talking to.
   *
   * Accepts a bare uuid or a typeid; a refused call resolves with `ok: false` rather than throwing.
   */
  test(endpointId: string): Promise<LLMEndpointTestResult> {
    return apiClient.post(`${this.base}/test`, { endpoint_typeid: endpointId });
  }

  /**
   * The hub's resolved chain for `endpointId` — which hops a call travels, and which root's
   * provider key it ends up spending.
   *
   * The companion of `test`, and the reason both exist: a verdict says the call SUCCEEDED, it
   * does not say what paid. Reachable only through the box for the same reason `test` is —
   * the hub's `chain` action addresses an entity a desktop has no row for.
   */
  chain(endpointId: string): Promise<LLMChain> {
    return apiClient.get(`${this.base}/chain/${encodeURIComponent(endpointId)}`);
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
