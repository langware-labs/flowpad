/**
 * The LLM sources pointer grammar. A leaf module with no React, because the version popover
 * imports it — so it is cheap to test directly and expensive to break.
 */
import { describe, expect, it } from 'vitest';

import { llmSourcesPointer, parseLlmSourcesPointer } from '@src/components/llm-sources/llm-sources-pointer';

describe('llm-sources pointer', () => {
  it('round-trips a worker', () => {
    for (const worker of ['claude', 'codex', 'copilot', 'opencode']) {
      expect(parseLlmSourcesPointer(llmSourcesPointer(worker))).toBe(worker);
    }
  });

  it('answers undefined for "no harness named"', () => {
    // The view falls back to the first harness. Empty is a legitimate address (the page's own
    // default), not an error, so it must not throw or invent one.
    for (const pointer of ['', undefined, null, '/']) {
      expect(parseLlmSourcesPointer(pointer)).toBeUndefined();
    }
  });

  it('takes only the first segment, so a stale deeper address still resolves', () => {
    // An earlier draft addressed `<section>/<key>`; a bookmark from then must still land
    // somewhere sensible rather than yielding a worker named "device".
    expect(parseLlmSourcesPointer('claude/extra')).toBe('claude');
  });

  it('does not validate the worker — the view matches it against what the box reported', () => {
    // Validating here would need a second copy of the vendor table; the view instead looks the
    // worker up in the harness kinds the backend actually returned and falls back when it misses.
    expect(parseLlmSourcesPointer('not-a-worker')).toBe('not-a-worker');
  });
});
