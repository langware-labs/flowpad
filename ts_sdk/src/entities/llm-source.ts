/**
 * `LLMSource` — where a worker's tokens come from. The TypeScript mirror of the backend
 * `DataSpec` (`flow_sdk/schema/data_spec/llm_source_spec.py`), maintained by hand 1:1, the
 * same way `lm-providers.ts` mirrors `LMApiProvider`.
 *
 * One value covers all three funding paths — a vendor **device login**, a stored **api_key**,
 * or a hub **endpoint** — so a surface can render "what pays for this harness" without
 * re-deriving it from `Capability.auth_mode` + `api_provider`. Every consumer used to do that
 * derivation itself, slightly differently.
 *
 * Not to be confused with the *other* "sources" on the endpoints screen
 * (`llm-endpoints/SourcesPicker.tsx`), which are the upstream endpoints a chain draws from.
 * An `LLMSource` names a way to pay; those name a budget upstream of another budget.
 */

export enum LLMSourceKind {
  /** The vendor CLI's own OAuth credentials, on this machine. */
  Device = 'device',
  /** A provider key the user stored (`lm_api.<provider>` in the sod). */
  ApiKey = 'api_key',
  /** A hub `LLMEndpoint` — a budget, spent with the hub login key. */
  Endpoint = 'endpoint',
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
  kind: LLMSourceKind;
  /** `LMApiProvider` value; `''` for a device source. */
  provider: string;
  /** `llm_endpoint-<uuid>`; `''` unless `kind` is `Endpoint`. */
  endpoint_typeid: string;
  name: string;
  /** Secondary display line. Display ONLY — never branch on it. */
  detail: string;
  /** For an endpoint, the provider its root talks to. */
  root_provider: string;
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

/** Identity is the tuple `(kind, provider, endpoint_typeid)` — a value, not a row. Compare
 *  sources with this rather than by whole value: the same source re-listed a second later
 *  with a fresh verdict is still the same source, and comparing everything would drop the
 *  user's selection on every refresh. */
export function llmSourceRef(source: LLMSource): string {
  return `${source.kind}|${source.provider}|${source.endpoint_typeid}`;
}

export function sameLlmSource(a: LLMSource, b: LLMSource): boolean {
  return llmSourceRef(a) === llmSourceRef(b);
}
