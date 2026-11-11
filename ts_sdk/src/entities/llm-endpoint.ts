/**
 * LLMEndpoint — a hub entity (`hub llm_endpoint.py`) that is
 * either a ROOT (talks to a provider with its own credential) or a CHAIN (fed
 * from other endpoints, in fallback order, narrowing what passes through).
 *
 * The hub owns the contract; this is a typed mirror. `provider` and `base_url`
 * are immutable once created, `credential_hint` is written only by the hub's
 * `credential` action (never by a save), and a chain never holds a credential.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import type { RemainingEntry } from '../FlowSync/store';

export type LLMEndpointProvider = 'openrouter' | 'anthropic' | 'openai' | 'vertex';
export const LLM_ENDPOINT_PROVIDERS: readonly LLMEndpointProvider[] = ['openrouter', 'anthropic', 'openai', 'vertex'];

export type LLMStreamingPolicy = 'allow' | 'require' | 'deny';

export interface LLMEndpointFilters {
  models_allow: string[];
  models_deny: string[];
  /** Upstream hosts an OpenRouter root must not be routed to (OpenRouter's names, e.g. `Novita`). */
  providers_ignore: string[];
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

/** The portable model sizes a worker asks an endpoint for. */
export type LLMModelSize = 'sm' | 'md' | 'lg';
export const LLM_MODEL_SIZES: readonly LLMModelSize[] = ['sm', 'md', 'lg'];

/** Which model this endpoint serves for each size; `null` = inherit from the next hop up. */
export type LLMEndpointTiers = Record<LLMModelSize, string | null>;
export const EMPTY_LLM_TIERS: LLMEndpointTiers = { sm: null, md: null, lg: null };

export const DEFAULT_LLM_FILTERS: LLMEndpointFilters = {
  models_allow: [],
  models_deny: [],
  providers_ignore: [],
  max_tokens_ceiling: null,
  max_input_chars: null,
  temperature_max: null,
  top_p_max: null,
  betas_allow: null,
  streaming: 'allow',
  paths_allow: ['v1/**'],
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
  member_default_limits?: Partial<LLMEndpointLimits>;
  credential_hint?: string;
  public?: boolean;
  tiers?: Partial<LLMEndpointTiers>;
  models?: string[];
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
  /** The budget the hub stamps on member defaults sourced from this endpoint
   *  (team/org scope endpoints); same shape as `limits`. */
  member_default_limits: LLMEndpointLimits = { ...DEFAULT_LLM_LIMITS };
  /** Whose pot / whose allowance this is lives in the hub's `partof` EDGES (pool → org/team,
   *  allowance → user), never in a field; the budgets screens read it through the hub's rows
   *  (`MemberBudget.user_id`) and the box through `LLMEndpointOffer.is_mine`. */
  /** `""` or `****abcd`; read-only, written by the hub's credential action. */
  credential_hint: string = '';
  /**
   * Spendable by whoever holds the id, with no login (`flow llm user use <id>`). Read-only:
   * toggled by the hub's `public` action, which refuses an endpoint with no cost limit.
   */
  public: boolean = false;
  /** The model each size runs, as set on THIS endpoint (`null` = inherited; the resolved map is
   *  `expand.tiers` on a permissions read, and `effective_tiers` on the chain). */
  tiers: LLMEndpointTiers = { ...EMPTY_LLM_TIERS };
  /** Root only: the catalog this root offers. Empty = the provider's own listing. */
  models: string[] = [];

  constructor(entity: Partial<ILLMEndpoint> = {}) {
    super(entity);
    this.name = entity.name ?? this.name;
    this.enabled = entity.enabled ?? this.enabled;
    this.provider = entity.provider ?? this.provider;
    this.base_url = entity.base_url ?? this.base_url;
    this.sources = entity.sources ?? this.sources;
    this.filters = { ...DEFAULT_LLM_FILTERS, ...(entity.filters ?? {}) };
    this.limits = { ...DEFAULT_LLM_LIMITS, ...(entity.limits ?? {}) };
    this.member_default_limits = { ...DEFAULT_LLM_LIMITS, ...(entity.member_default_limits ?? {}) };
    this.credential_hint = entity.credential_hint ?? this.credential_hint;
    this.public = entity.public ?? this.public;
    this.tiers = { ...EMPTY_LLM_TIERS, ...(entity.tiers ?? {}) };
    this.models = entity.models ?? this.models;
  }

  /** The model each size resolves to down this endpoint's chain, from the hub's expansion. */
  get effectiveTiers(): LLMEndpointTiers {
    return { ...EMPTY_LLM_TIERS, ...(this.expand?.tiers ?? {}) };
  }

  /** What this endpoint draws from, as bare ids (the form `id` takes): the hub's answer on a
   *  permissions read (its `partof` edges, typeids), else the local `sources` field. */
  get parentIds(): string[] {
    const prefix = `${LLMEndpoint.type}-`;
    return (this.expand?.source_ids ?? this.sources).map((ref) =>
      ref.startsWith(prefix) ? ref.slice(prefix.length) : ref,
    );
  }

  /** Root ⇔ no sources. Derived, never stored. */
  get kind(): LLMEndpointKind {
    return this.parentIds.length ? 'chain' : 'root';
  }

  /** Who sponsors this budget: `global` | `organization` | `team` | `user`; null when unknown. */
  get sponsorKind(): string | null {
    return this.expand?.scope_kind ?? null;
  }

  /** This endpoint's own limits with what is used of them (permissions read only). */
  get ownRemaining(): RemainingEntry[] {
    return this.expand?.remaining ?? [];
  }

  /** The hub lets this caller carve a budget out of this one. */
  get canAllocate(): boolean {
    return !!this.expand?.allowed_actions && this.isAllowedAction('allocate' as never);
  }

  /** The hub lets this caller change this endpoint's name (`rename`: its holder or an admin). */
  get canRename(): boolean {
    return !!this.expand?.allowed_actions && this.isAllowedAction('rename' as never);
  }

  /** The caller's own budget (an allowance they hold), as the hub answers it. */
  get isMine(): boolean {
    return this.expand?.mine === true;
  }

  get hasCredential(): boolean {
    return this.credential_hint.length > 0;
  }
}
