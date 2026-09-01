/**
 * Filters/limits form ↔ JSON: lines ↔ lists, '' ↔ null, betas null vs [],
 * mapping rows ↔ records — proven by round-trip.
 */
import type { LLMEndpointFilters, LLMEndpointLimits } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  badNonNegative,
  filtersToForm,
  formToFilters,
  formToLimits,
  LIMIT_KEYS,
  limitsToForm,
  numOrNull,
  rowsToRecord,
  splitLines,
} from '@src/components/llm-endpoints/filters-limits-forms';

describe('primitives', () => {
  it('splitLines trims and drops blanks', () => {
    expect(splitLines(' a/* \n\n  b/*\r\n')).toEqual(['a/*', 'b/*']);
  });

  it("numOrNull: '' → null, text → number (NaN when not numeric)", () => {
    expect(numOrNull('')).toBeNull();
    expect(numOrNull('  ')).toBeNull();
    expect(numOrNull('4096')).toBe(4096);
    expect(numOrNull('0.5')).toBe(0.5);
    expect(Number.isNaN(numOrNull('abc') as number)).toBe(true);
  });

  it('rowsToRecord drops blank keys and trims', () => {
    expect(
      rowsToRecord([
        { from: ' fast ', to: ' anthropic/claude-3-5-haiku ' },
        { from: '', to: 'x' },
      ]),
    ).toEqual({
      fast: 'anthropic/claude-3-5-haiku',
    });
  });

  it('badNonNegative reports the offending keys only', () => {
    expect(badNonNegative({ a: '', b: '-1', c: 'x', d: '3' }, ['a', 'b', 'c', 'd'])).toEqual(['b', 'c']);
  });
});

describe('filters round-trip', () => {
  const filters: LLMEndpointFilters = {
    models_allow: ['anthropic/*', 'openai/gpt-4*'],
    models_deny: ['*/preview'],
    max_tokens_ceiling: 4096,
    max_input_chars: null,
    temperature_max: 0.7,
    top_p_max: null,
    betas_allow: ['prompt-caching-2024-07-31'],
    streaming: 'require',
    paths_allow: ['v1/messages'],
    aliases: { fast: 'anthropic/claude-3-5-haiku' },
    model_map: {},
  };

  it('JSON → form → JSON is the identity', () => {
    expect(formToFilters(filtersToForm(filters))).toEqual(filters);
  });

  it("the hub's default paths_allow (['v1/**']) survives an untouched edit — never sent back as []", () => {
    expect(formToFilters(filtersToForm({ paths_allow: ['v1/**'] })).paths_allow).toEqual(['v1/**']);
    // And a fresh form starts from that default rather than an empty allowlist.
    expect(formToFilters(filtersToForm(null)).paths_allow).toEqual(['v1/**']);
  });

  it('a form shows lists as lines and nulls as empty', () => {
    const form = filtersToForm(filters);
    expect(form.models_allow).toBe('anthropic/*\nopenai/gpt-4*');
    expect(form.max_input_chars).toBe('');
    expect(form.max_tokens_ceiling).toBe('4096');
    expect(form.betasRestricted).toBe(true);
    expect(form.aliases).toEqual([{ from: 'fast', to: 'anthropic/claude-3-5-haiku' }]);
  });

  it('betas: null (no restriction) vs [] (restricted to none) survive', () => {
    const open = filtersToForm({ betas_allow: null });
    expect(open.betasRestricted).toBe(false);
    expect(formToFilters(open).betas_allow).toBeNull();
    const closed = filtersToForm({ betas_allow: [] });
    expect(closed.betasRestricted).toBe(true);
    expect(formToFilters(closed).betas_allow).toEqual([]);
  });

  it('missing fields take the defaults', () => {
    const f = formToFilters(filtersToForm(undefined));
    expect(f).toMatchObject({ models_allow: [], streaming: 'allow', betas_allow: null, aliases: {}, model_map: {} });
  });

  it('non-numeric text never becomes NaN in JSON', () => {
    const form = { ...filtersToForm(null), temperature_max: 'hot' };
    expect(formToFilters(form).temperature_max).toBeNull();
  });
});

describe('limits round-trip', () => {
  const limits: LLMEndpointLimits = {
    tokens_total: 1_000_000,
    tokens_per_day: null,
    tokens_per_week: null,
    tokens_per_month: 50_000_000,
    cost_usd_total: 5,
    cost_usd_per_day: 0.5,
    cost_usd_per_week: null,
    cost_usd_per_month: null,
    requests_per_minute: 60,
  };

  it('JSON → form → JSON is the identity', () => {
    expect(formToLimits(limitsToForm(limits))).toEqual(limits);
  });

  it('every key is present in the form, empty for null', () => {
    const form = limitsToForm(limits);
    expect(Object.keys(form).sort()).toEqual([...LIMIT_KEYS].sort());
    expect(form.tokens_per_day).toBe('');
    expect(form.cost_usd_per_day).toBe('0.5');
  });

  it('an all-empty form is all nulls', () => {
    const l = formToLimits(limitsToForm(null));
    for (const k of LIMIT_KEYS) expect(l[k]).toBeNull();
  });
});
