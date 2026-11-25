/**
 * APIEndpoint — the hub's `api_endpoint`: a budget over a third-party HTTP API (pictures, video, any
 * cloud API). A ROOT holds the vendor's key, where it goes (`target`) and what a call costs (`meter`);
 * an allocation draws on other endpoints and narrows them with filters and limits.
 *
 * It is the same budget node as an LLM endpoint — name, enabled, limits, a chain of sources, a
 * write-only credential — so it extends `LLMEndpoint` and the endpoints screen draws both with one
 * set of components. What differs is here: no provider or models; `kinds`, `target` and `meter`
 * instead; request limits beside the dollar limits; filters that are paths and methods.
 */
import { registerEntity } from '../APIEntity';
import { LLMEndpoint, type ILLMEndpoint } from './llm-endpoint';

/** Where the vendor's key goes in a forwarded request: one header (or query parameter). */
export interface APIEndpointInject {
  header?: string | null;
  query?: string | null;
  /** How the key is written there; `{value}` is the key (`Bearer {value}`). */
  format?: string;
}

export interface APIEndpointTarget {
  base_url: string;
  inject?: APIEndpointInject | null;
  /** A read-only path the hub may GET to check the key; empty = never probed. */
  probe_path?: string;
}

/** A number in the JSON request that multiplies a rule's price (a clip's seconds). */
export interface APIEndpointPriceFactor {
  field: string;
  default?: number;
}

/** `usd` for one call whose path matches `path` (a glob); the first matching rule prices the call. */
export interface APIEndpointPriceRule {
  path: string;
  usd: number;
  times?: APIEndpointPriceFactor[];
}

export interface APIEndpointMeter {
  kind: 'requests' | 'json_usage' | 'per_call';
  rules?: APIEndpointPriceRule[];
  input_usd_per_million?: number;
  output_usd_per_million?: number;
}

export interface APIEndpointFilters {
  methods_allow: string[];
  paths_allow: string[];
}

export interface APIEndpointLimits {
  cost_usd_total: number | null;
  cost_usd_per_day: number | null;
  cost_usd_per_week: number | null;
  cost_usd_per_month: number | null;
  requests_total: number | null;
  requests_per_day: number | null;
  requests_per_week: number | null;
  requests_per_month: number | null;
  requests_per_minute: number | null;
}

export const DEFAULT_API_LIMITS: APIEndpointLimits = {
  cost_usd_total: null,
  cost_usd_per_day: null,
  cost_usd_per_week: null,
  cost_usd_per_month: null,
  requests_total: null,
  requests_per_day: null,
  requests_per_week: null,
  requests_per_month: null,
  requests_per_minute: null,
};

export interface IAPIEndpoint extends Omit<ILLMEndpoint, 'filters' | 'limits'> {
  kinds?: string[];
  target?: Partial<APIEndpointTarget>;
  meter?: Partial<APIEndpointMeter>;
  filters?: Partial<APIEndpointFilters>;
  limits?: Partial<APIEndpointLimits>;
}

@registerEntity
export class APIEndpoint extends LLMEndpoint {
  static type: string = 'api_endpoint';

  /** What the API behind this root is, so a caller finds it by purpose: `image.generate`, `video.generate`. */
  kinds: string[] = [];
  target: APIEndpointTarget = { base_url: '' };
  meter: APIEndpointMeter = { kind: 'requests', rules: [] };

  constructor(entity: Partial<IAPIEndpoint> = {}) {
    super(entity as Partial<ILLMEndpoint>);
    this.provider = '';
    this.kinds = entity.kinds ?? this.kinds;
    this.target = { base_url: '', ...(entity.target ?? {}) };
    this.base_url = this.target.base_url;
    this.meter = { kind: 'requests', rules: [], ...(entity.meter ?? {}) };
    // The parent filled both with the LLM defaults; an API endpoint has its own fields.
    this.filters = { methods_allow: [], paths_allow: [], ...(entity.filters ?? {}) } as never;
    this.limits = { ...DEFAULT_API_LIMITS, ...(entity.limits ?? {}) } as never;
  }

  /** The limits as an API endpoint holds them (dollars and requests, no tokens). */
  get apiLimits(): APIEndpointLimits {
    return this.limits as unknown as APIEndpointLimits;
  }

  get apiFilters(): APIEndpointFilters {
    return this.filters as unknown as APIEndpointFilters;
  }
}
