import { describe, expect, it } from 'vitest';
import { accentToHslTriple } from '@src/components/helpdesk/useHelpdeskBrand';

// The accent comes from a JSON file in a cloned repo, so it is untrusted input
// applied to a CSS variable. A bad value must fall back, never paint the
// container transparent — which is what an unparsed value would do, silently.

describe('accentToHslTriple', () => {
  it('converts the Langware brand blue', () => {
    // #0974F1 — read from the brand kit's logomark.svg.
    expect(accentToHslTriple('#0974F1')).toBe('212 93% 49%');
  });

  it('accepts shorthand and a missing hash', () => {
    expect(accentToHslTriple('#fff')).toBe('0 0% 100%');
    expect(accentToHslTriple('0974F1')).toBe('212 93% 49%');
    expect(accentToHslTriple('  #0974F1  ')).toBe('212 93% 49%');
  });

  it('handles greys, where hue is undefined', () => {
    expect(accentToHslTriple('#000000')).toBe('0 0% 0%');
    expect(accentToHslTriple('#808080')).toBe('0 0% 50%');
  });

  it('resolves hue from each dominant channel', () => {
    expect(accentToHslTriple('#ff0000')).toBe('0 100% 50%');
    expect(accentToHslTriple('#00ff00')).toBe('120 100% 50%');
    expect(accentToHslTriple('#0000ff')).toBe('240 100% 50%');
  });

  it('returns null for anything unparseable rather than a broken triple', () => {
    for (const bad of ['', 'blue', '#12', '#12345', '#zzzzzz', 'rgb(1,2,3)', '#1234567']) {
      expect(accentToHslTriple(bad), bad).toBeNull();
    }
  });
});
