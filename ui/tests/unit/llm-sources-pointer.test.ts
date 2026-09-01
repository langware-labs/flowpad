/**
 * The LLM sources pointer grammar. A leaf module with no React, because the version popover and
 * the warnings popover both import it — so it is cheap to test directly and expensive to break.
 */
import { LlmSourcesSection } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  llmSourcesPointer,
  parseLlmSourcesPointer,
  pointerForSource,
} from '@src/components/llm-sources/llm-sources-pointer';

describe('llm-sources pointer', () => {
  it('round-trips every section', () => {
    for (const section of Object.values(LlmSourcesSection)) {
      expect(parseLlmSourcesPointer(llmSourcesPointer(section))).toEqual({ section });
    }
  });

  it('round-trips a section with its key', () => {
    expect(parseLlmSourcesPointer('device/claude')).toEqual({
      section: LlmSourcesSection.Device,
      key: 'claude',
    });
    expect(llmSourcesPointer(LlmSourcesSection.Key, 'openrouter')).toBe('key/openrouter');
  });

  it('falls back to the list rather than inventing a section', () => {
    // An unknown leading segment is a stale or hand-typed URL. Landing on the list is
    // recoverable; rendering a section that does not exist is not.
    for (const pointer of ['', undefined, null, 'nonsense', 'nonsense/claude']) {
      expect(parseLlmSourcesPointer(pointer)).toEqual({});
    }
  });

  it('keeps an endpoint id intact even though it contains the delimiter', () => {
    const id = 'llm_endpoint-7f1c9d2e-0000-4a00-8000-11e0e0e0e0e0';
    expect(parseLlmSourcesPointer(`endpoint/${id}`)).toEqual({
      section: LlmSourcesSection.Endpoint,
      key: id,
    });
  });

  it('spells a source the same way a row and a deep link would', () => {
    expect(pointerForSource({ kind: 'api_key', provider: 'openrouter', endpoint_typeid: '' })).toBe(
      'key/openrouter',
    );
    expect(pointerForSource({ kind: 'endpoint', provider: 'flowpad', endpoint_typeid: 'llm_endpoint-x' })).toBe(
      'endpoint/llm_endpoint-x',
    );
  });
});
