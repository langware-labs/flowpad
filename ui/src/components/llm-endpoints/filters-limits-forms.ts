/**
 * Filters/limits as a FORM, and the round-trip to the entity's JSON.
 *
 * The form holds strings — that is what inputs hold, and it lets validation say
 * "temperature must be a number" instead of coercing `"abc"` to `NaN` and
 * saving it. Two conventions, both directions:
 *   - textarea lines ↔ string lists (globs, paths, betas): one per line,
 *     blank lines dropped;
 *   - `''` ↔ `null` for optional numbers (an empty field is "no ceiling").
 *
 * **Pure — no React, no SDK.** Unit-tested by round-trip.
 */
import type { LLMEndpointFilters, LLMEndpointLimits, LLMStreamingPolicy } from '@sdk';
import { DEFAULT_LLM_FILTERS, DEFAULT_LLM_LIMITS } from '@sdk';

export const STREAMING_POLICIES: readonly LLMStreamingPolicy[] = ['allow', 'require', 'deny'];

/**
 * The globs a NEW endpoint starts with — a real, saved value, not a hint.
 *
 * An empty `models_allow` means "everything the sources allow", and on a hub whose seeded root
 * carries no filters that is the entire OpenRouter catalogue: free-tier models, moderation models,
 * even music models. Defaulting to the two families anything routed through here actually asks for
 * makes the safe configuration the one you get by doing nothing.
 *
 * `anthropic/claude-*` is what a Claude Code harness routed through the hub sends —
 * `CLAUDE_API_AUTH_SPEC.tier_models` stamps OpenRouter slugs (`anthropic/claude-haiku-4.5`,
 * `-sonnet-4.5`, `-opus-4.1`) onto argv before spawn, so one glob covers every tier.
 */
export const MODELS_ALLOW_DEFAULT = 'anthropic/claude-*\nopenai/gpt-*';

/** One `from → to` row of an aliases / model_map editor. */
export interface MappingRow {
  from: string;
  to: string;
}

export interface FiltersForm {
  models_allow: string;
  models_deny: string;
  max_tokens_ceiling: string;
  max_input_chars: string;
  temperature_max: string;
  top_p_max: string;
  /** Empty = "no restriction" (null); lines = the allowed betas. `betasRestricted`
   *  distinguishes "restrict to none" from "no restriction". */
  betas_allow: string;
  betasRestricted: boolean;
  streaming: LLMStreamingPolicy;
  paths_allow: string;
  aliases: MappingRow[];
  model_map: MappingRow[];
}

export type LimitKey = keyof LLMEndpointLimits;

export const LIMIT_KEYS: readonly LimitKey[] = [
  'tokens_total',
  'tokens_per_day',
  'tokens_per_week',
  'tokens_per_month',
  'cost_usd_total',
  'cost_usd_per_day',
  'cost_usd_per_week',
  'cost_usd_per_month',
  'requests_per_minute',
];

export type LimitsForm = Record<LimitKey, string>;

export const NUMERIC_FILTER_KEYS = ['max_tokens_ceiling', 'max_input_chars', 'temperature_max', 'top_p_max'] as const;
export type NumericFilterKey = (typeof NUMERIC_FILTER_KEYS)[number];

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinLines(items: readonly string[] | null | undefined): string {
  return (items ?? []).join('\n');
}

/** `''` → null; anything else → the parsed number (NaN when not numeric — the
 *  validator reports it; `formToX` never writes a NaN). */
export function numOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return Number(trimmed);
}

export function textOrEmpty(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

export function recordToRows(record: Record<string, string> | null | undefined): MappingRow[] {
  return Object.entries(record ?? {}).map(([from, to]) => ({ from, to }));
}

/** Rows → record. Blank `from`s are dropped; a later duplicate wins, as an
 *  object literal would. */
export function rowsToRecord(rows: readonly MappingRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const from = row.from.trim();
    if (!from) continue;
    out[from] = row.to.trim();
  }
  return out;
}

export function filtersToForm(filters: Partial<LLMEndpointFilters> | null | undefined): FiltersForm {
  const f: LLMEndpointFilters = { ...DEFAULT_LLM_FILTERS, ...(filters ?? {}) };
  return {
    models_allow: joinLines(f.models_allow),
    models_deny: joinLines(f.models_deny),
    max_tokens_ceiling: textOrEmpty(f.max_tokens_ceiling),
    max_input_chars: textOrEmpty(f.max_input_chars),
    temperature_max: textOrEmpty(f.temperature_max),
    top_p_max: textOrEmpty(f.top_p_max),
    betas_allow: joinLines(f.betas_allow),
    betasRestricted: f.betas_allow !== null && f.betas_allow !== undefined,
    streaming: f.streaming ?? 'allow',
    paths_allow: joinLines(f.paths_allow),
    aliases: recordToRows(f.aliases),
    model_map: recordToRows(f.model_map),
  };
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function formToFilters(form: FiltersForm): LLMEndpointFilters {
  return {
    models_allow: splitLines(form.models_allow),
    models_deny: splitLines(form.models_deny),
    max_tokens_ceiling: finiteOrNull(numOrNull(form.max_tokens_ceiling)),
    max_input_chars: finiteOrNull(numOrNull(form.max_input_chars)),
    temperature_max: finiteOrNull(numOrNull(form.temperature_max)),
    top_p_max: finiteOrNull(numOrNull(form.top_p_max)),
    betas_allow: form.betasRestricted ? splitLines(form.betas_allow) : null,
    streaming: form.streaming,
    paths_allow: splitLines(form.paths_allow),
    aliases: rowsToRecord(form.aliases),
    model_map: rowsToRecord(form.model_map),
  };
}

export function limitsToForm(limits: Partial<LLMEndpointLimits> | null | undefined): LimitsForm {
  const l: LLMEndpointLimits = { ...DEFAULT_LLM_LIMITS, ...(limits ?? {}) };
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, textOrEmpty(l[k])])) as LimitsForm;
}

export function formToLimits(form: LimitsForm): LLMEndpointLimits {
  return Object.fromEntries(
    LIMIT_KEYS.map((k) => [k, finiteOrNull(numOrNull(form[k] ?? ''))]),
  ) as unknown as LLMEndpointLimits;
}

/** The numeric fields of a form that do not parse to a non-negative number,
 *  by key. Empty is fine (means null). */
export function badNonNegative<K extends string>(form: Record<K, string>, keys: readonly K[]): K[] {
  return keys.filter((k) => {
    const raw = (form[k] ?? '').trim();
    if (raw === '') return false;
    const n = Number(raw);
    return !Number.isFinite(n) || n < 0;
  });
}
