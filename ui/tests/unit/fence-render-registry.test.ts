import {
  clearFenceRenderers,
  getFenceRenderer,
  registerFenceRenderer,
  type FenceRenderer,
} from '@src/components/milkdown-editor/plugins/fence-render/registry';
import { afterEach, describe, expect, it } from 'vitest';

function renderer(language: string): FenceRenderer {
  return { language, tabLabel: language, render: () => {} };
}

afterEach(() => clearFenceRenderers());

describe('fence renderer registry', () => {
  it('returns the renderer registered for a language', () => {
    const mermaid = renderer('mermaid');
    registerFenceRenderer(mermaid);
    expect(getFenceRenderer('mermaid')).toBe(mermaid);
  });

  /*
   * The whole fallback path hangs off this returning undefined: `undefined`
   * is what makes the NodeView emit a plain `pre > code` instead of the tab
   * strip, so every unregistered language keeps behaving as it did before the
   * plugin existed.
   */
  it('returns undefined for an unregistered language', () => {
    registerFenceRenderer(renderer('mermaid'));
    expect(getFenceRenderer('python')).toBeUndefined();
  });

  it('returns undefined for a fence with no info string', () => {
    registerFenceRenderer(renderer('mermaid'));
    // A bare ``` fence parses to `language: ''`, which must not match.
    expect(getFenceRenderer('')).toBeUndefined();
    expect(getFenceRenderer(null)).toBeUndefined();
    expect(getFenceRenderer(undefined)).toBeUndefined();
  });

  it('is case- and whitespace-sensitive: only the exact info string matches', () => {
    registerFenceRenderer(renderer('mermaid'));
    expect(getFenceRenderer('Mermaid')).toBeUndefined();
    expect(getFenceRenderer('mermaid ')).toBeUndefined();
  });

  it('lets a later registration replace an earlier one for the same language', () => {
    registerFenceRenderer(renderer('mermaid'));
    const replacement = renderer('mermaid');
    registerFenceRenderer(replacement);
    expect(getFenceRenderer('mermaid')).toBe(replacement);
  });
});
