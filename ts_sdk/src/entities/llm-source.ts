/**
 * `LLMSource` — where a worker's tokens come from. The TypeScript mirror of the backend
 * `DataSpec` (`flow_sdk/schema/data_spec/llm_source_spec.py`), maintained by hand 1:1, the
 * same way `lm-providers.ts` mirrors `LMApiProvider`.
 *
 * It is a **verdict about one endpoint**, not a description of one: it names an
 * `endpoint_typeid` and adds eligibility, so a surface can render "what pays for this
 * harness" without re-deriving it from `Capability.auth_mode` + `api_provider`. It is kept
 * separate from the endpoint because a verdict is per-harness and the endpoint is not — the
 * same stored key is eligible for one harness and refused by another, so the status payload
 * holds several verdicts naming the same endpoint at once.
 *
 * Not to be confused with the *other* "sources" on the endpoints screen
 * (`llm-endpoints/SourcesPicker.tsx`), which are the upstream endpoints a chain draws from.
 * An `LLMSource` names a way to pay; those name a budget upstream of another budget.
 */

/** What kind of thing pays. Mirrors the Python `LLMEndpointKind`
 *  (`flow_sdk/builtin/llm_endpoint.py`) — it lives on the ENDPOINT now, not on the verdict, so
 *  read it from `LLMFundingStatus.endpoints[source.endpoint_typeid]`.
 *
 *  Named `LLMFundingKind` because `LLMEndpointKind` is taken in `llm-endpoint.ts` for the
 *  unrelated root-vs-chain topology of a hub budget. */
export enum LLMFundingKind {
  /** The vendor CLI's own OAuth credentials, on this machine. Never callable in-process. */
  Device = 'device',
  /** A provider key the user stored (`lm_api.<provider>` in the sod). */
  ApiKey = 'api_key',
  /** A hub `LLMEndpoint` — a budget, spent with the hub login key. */
  Hub = 'hub',
}

/** The vocabulary the *pick* endpoint still speaks (`select_llm_source`). Deliberately
 *  separate from `LLMEndpointKind`: the payload predates endpoints being rows and spells the
 *  hub kind `endpoint`. Collapsing the two is Phase 3, when the picker starts posting a bare
 *  endpoint typeid. */
export enum LLMSourceKind {
  Device = 'device',
  ApiKey = 'api_key',
  Endpoint = 'endpoint',
}

/** `LLMFundingKind` → the spelling `select_llm_source` expects. */
export function selectKindFor(kind: LLMFundingKind | string): LLMSourceKind {
  return kind === LLMFundingKind.Hub ? LLMSourceKind.Endpoint : (kind as unknown as LLMSourceKind);
}

/** How good the eligibility answer is. Never flatten this into `eligible`. */
export enum LLMSourceAuthority {
  /** Something authoritative was asked and answered. */
  Proven = 'proven',
  /** Read from a cache that is stale by construction — nothing invalidates a device
   *  `login_state` when the user signs out of the CLI in a terminal. */
  Cached = 'cached',
  /** Locally unknowable; the authority is elsewhere (the hub answers at invoke time). */
  Presumed = 'presumed',
}

/** Which rung of the resolution ladder produced this verdict. */
export enum LLMSourceOrigin {
  Process = 'process',
  Project = 'project',
  User = 'user',
  Default = 'default',
}

export interface LLMSource {
  /** The endpoint this verdict is about — `llm_endpoint-<uuid>`, always set. Everything else
   *  about the source (kind, provider, models) lives on the endpoint; look it up in
   *  `LLMFundingStatus.endpoints`. This type deliberately mirrors none of it. */
  endpoint_typeid: string;
  name: string;
  /** Secondary display line. Display ONLY — never branch on it. */
  detail: string;
  eligible: boolean;
  /** Why not, when not — and only when not. **Render it verbatim**: the backend owns this
   *  sentence so the picker and the spawn error cannot disagree, and a second author would
   *  drift from the resolver. */
  reason: string;
  /** Eligible ≠ auto-selectable. Five endpoints are all eligible; one is auto. */
  auto: boolean;
  authority: LLMSourceAuthority;
  /** Position in the preference order; lower is preferred. */
  rank: number;
  origin: LLMSourceOrigin;
}

/** Identity is the endpoint it names. Compare sources with this rather than by whole value:
 *  the same source re-listed a second later with a fresh verdict is still the same source,
 *  and comparing everything would drop the user's selection on every refresh. */
export function llmSourceRef(source: LLMSource): string {
  return source.endpoint_typeid;
}

export function sameLlmSource(a: LLMSource, b: LLMSource): boolean {
  return llmSourceRef(a) === llmSourceRef(b);
}
