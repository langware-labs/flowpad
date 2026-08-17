/**
 * LLMEndpoint — a hub entity (`flowpad/hub/builtin/llm_endpoint.py`) that is
 * either a ROOT (talks to a provider with its own credential) or a CHAIN (fed
 * from other endpoints, in fallback order, narrowing what passes through).
 *
 * The hub owns the contract; this is a typed mirror. `provider` and `base_url`
 * are immutable once created, `credential_hint` is written only by the hub's
 * `credential` action (never by a save), and a chain never holds a credential.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export type LLMEndpointProvider = 'openrouter' | 'anthropic' | 'openai';
export const LLM_ENDPOINT_PROVIDERS: readonly LLMEndpointProvider[] = ['openrouter', 'anthropic', 'openai'];

export type LLMStreamingPolicy = 'allow' | 'require' | 'deny';

export interface LLMEndpointFilters {
  models_allow: string[];
  models_deny: string[];
  max_tokens_ceiling: number | null;
  max_input_chars: number | null;
  temperature_max: number | null;
  top_p_max: number | null;
  betas_allow: string[] | null;
  streaming: LLMStreamingPolicy;
  paths_allow: string[];
  aliases: Record<string, string>;
  model_map: Record<string, string>;
}

export interface LLMEndpointLimits {
  tokens_total: number | null;
  tokens_per_day: number | null;
  tokens_per_week: number | null;
  tokens_per_month: number | null;
  cost_usd_total: number | null;
  cost_usd_per_day: number | null;
  cost_usd_per_week: number | null;
  cost_usd_per_month: number | null;
  requests_per_minute: number | null;
}

export type LLMEndpointKind = 'root' | 'chain';

export const DEFAULT_LLM_FILTERS: LLMEndpointFilters = {
  models_allow: [],
  models_deny: [],
  max_tokens_ceiling: null,
  max_input_chars: null,
  temperature_max: null,
  top_p_max: null,
  betas_allow: null,
  streaming: 'allow',
  paths_allow: [],
  aliases: {},
  model_map: {},
};

export const DEFAULT_LLM_LIMITS: LLMEndpointLimits = {
  tokens_total: null,
  tokens_per_day: null,
  tokens_per_week: null,
  tokens_per_month: null,
  cost_usd_total: null,
  cost_usd_per_day: null,
  cost_usd_per_week: null,
  cost_usd_per_month: null,
  requests_per_minute: null,
};

export interface ILLMEndpoint extends IEntity {
  name?: string;
  enabled?: boolean;
  provider?: LLMEndpointProvider | string;
  base_url?: string;
  sources?: string[];
  filters?: Partial<LLMEndpointFilters>;
  limits?: Partial<LLMEndpointLimits>;
  credential_hint?: string;
}

@registerEntity
export class LLMEndpoint extends APIEntity<LLMEndpoint> implements ILLMEndpoint {
  static type: string = 'llm_endpoint';

  name: string = '';
  enabled: boolean = true;
  provider: LLMEndpointProvider | string = 'openrouter';
  base_url: string = '';
  /** Ordered typeids (`llm_endpoint-<uuid>`) — the fallback list. Non-empty ⇒ chain. */
  sources: string[] = [];
  filters: LLMEndpointFilters = { ...DEFAULT_LLM_FILTERS };
  limits: LLMEndpointLimits = { ...DEFAULT_LLM_LIMITS };
  /** `""` or `****abcd`; read-only, written by the hub's credential action. */
  credential_hint: string = '';

  constructor(entity: Partial<ILLMEndpoint> = {}) {
    super(entity);
    this.name = entity.name ?? this.name;
    this.enabled = entity.enabled ?? this.enabled;
    this.provider = entity.provider ?? this.provider;
    this.base_url = entity.base_url ?? this.base_url;
    this.sources = entity.sources ?? this.sources;
    this.filters = { ...DEFAULT_LLM_FILTERS, ...(entity.filters ?? {}) };
    this.limits = { ...DEFAULT_LLM_LIMITS, ...(entity.limits ?? {}) };
    this.credential_hint = entity.credential_hint ?? this.credential_hint;
  }

  /** Root ⇔ no sources. Derived, never stored. */
  get kind(): LLMEndpointKind {
    return this.sources.length ? 'chain' : 'root';
  }

  get isRoot(): boolean {
    return this.kind === 'root';
  }

  get hasCredential(): boolean {
    return this.credential_hint.length > 0;
  }
}
