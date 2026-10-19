/**
 * `keyShapeProblem` — what can be judged about a provider key without sending it.
 *
 * Deliberately prefix-and-shape only. A full-format regex would eventually reject valid keys as
 * providers lengthen the random part, and an owner cannot argue with a client that refuses a key
 * the provider itself accepts. The prefix is the stable part, and it catches the mistake that
 * actually happens: one provider's key pasted into another provider's root.
 */
import type { MessageDescriptor } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { keyShapeProblem } from '@src/components/llm-endpoints/endpoint-catalog';

/** A `msg` descriptor keeps its template in `message` (`"That looks like an {0} key…"`) and the
 *  interpolated values alongside it, so an assertion about WHICH provider was named reads the
 *  values, not the template. */
const said = (problem: MessageDescriptor | null) =>
  [problem?.message ?? '', ...Object.values(problem?.values ?? {}).map(String)].join(' | ');

const OPENROUTER = `sk-or-v1-${'a'.repeat(40)}`;
const ANTHROPIC = `sk-ant-api03-${'b'.repeat(40)}`;
const OPENAI = `sk-proj-${'c'.repeat(40)}`;

describe('keyShapeProblem — nothing to report', () => {
  it.each([
    ['openrouter', OPENROUTER],
    ['anthropic', ANTHROPIC],
    ['openai', OPENAI],
  ])('accepts a well-formed %s key', (provider, key) => {
    expect(keyShapeProblem(provider, key)).toBeNull();
  });

  it('says nothing about an empty box — that belongs to the caller, which knows if it was touched', () => {
    expect(keyShapeProblem('openrouter', '')).toBeNull();
    expect(keyShapeProblem('openrouter', '   ')).toBeNull();
  });

  it('says nothing when the provider is unknown or absent — it has no rule to apply', () => {
    expect(keyShapeProblem(null, 'whatever')).toBeNull();
    expect(keyShapeProblem(undefined, 'whatever')).toBeNull();
    expect(keyShapeProblem('some-future-provider', 'whatever')).toBeNull();
  });

  it('ignores surrounding whitespace, which a paste routinely carries', () => {
    expect(keyShapeProblem('openrouter', `  ${OPENROUTER}\n`)).toBeNull();
  });
});

describe('keyShapeProblem — the wrong provider entirely', () => {
  it('names both providers when an Anthropic key is pasted into an OpenRouter root', () => {
    const problem = keyShapeProblem('openrouter', ANTHROPIC);
    expect(problem).not.toBeNull();
    expect(said(problem)).toContain('Anthropic');
    expect(said(problem)).toContain('OpenRouter');
  });

  /**
   * The reason the foreign-prefix rule runs FIRST. OpenAI's prefix is `sk-`, which also prefixes
   * `sk-or-` and `sk-ant-` — so an OpenRouter key passes the expected-prefix rule on an OpenAI
   * root and would sail through if only that rule existed.
   */
  it('catches an OpenRouter key on an OpenAI root, whose own prefix would otherwise match', () => {
    const problem = keyShapeProblem('openai', OPENROUTER);
    expect(problem).not.toBeNull();
    expect(said(problem)).toContain('OpenRouter');
  });

  it('catches an Anthropic key on an OpenAI root for the same reason', () => {
    expect(keyShapeProblem('openai', ANTHROPIC)).not.toBeNull();
  });
});

describe('keyShapeProblem — malformed', () => {
  it('reports a key that carries no recognisable prefix at all', () => {
    const problem = keyShapeProblem('anthropic', `not-a-key-${'d'.repeat(40)}`);
    expect(said(problem)).toContain('sk-ant-');
  });

  it('reports an internal space or line break — the signature of a sloppy copy', () => {
    const problem = keyShapeProblem('openrouter', `sk-or-v1-${'a'.repeat(20)} ${'a'.repeat(20)}`);
    expect(problem?.message).toMatch(/space or line break/i);
  });

  it('reports a key cut short, which a half-selected paste produces', () => {
    const problem = keyShapeProblem('openrouter', 'sk-or-v1-abc');
    expect(problem?.message).toMatch(/cut short/i);
  });
});
