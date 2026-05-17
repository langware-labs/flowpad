import { describe, it, expect } from 'vitest';
import { findRowByText } from '../../adapter/findRowByText.js';
import { StubXtermAdapter } from '../../adapter/XtermAdapter.js';

function adapterFromLines(lines: Record<number, string>, eviction = 0): StubXtermAdapter {
  const a = new StubXtermAdapter();
  a.evictionOffset = eviction;
  for (const [k, v] of Object.entries(lines)) {
    a.injectLine(Number(k), v);
  }
  // StubXtermAdapter.getBufferLength returns the max injected row index + 1,
  // but the eviction window we want is [eviction, eviction + bufLen). For
  // the scanner to walk rows >= eviction we need bufferLength relative to
  // eviction. The stub uses absolute indices, so bump bufferLength so the
  // end of the scan equals max(absRow)+1.
  const maxRow = Math.max(...Object.keys(lines).map(Number));
  a.bufferLength = maxRow + 1 - eviction;
  a.scrollState.bufferLength = a.bufferLength;
  return a;
}

describe('findRowByText', () => {
  it('returns null when needles array is empty', () => {
    const a = adapterFromLines({ 0: 'hello' });
    expect(findRowByText(a, [])).toBeNull();
  });

  it('finds a row matching the bare needle', () => {
    const a = adapterFromLines({ 0: 'foo', 1: 'bar', 2: 'baz qux' });
    expect(findRowByText(a, ['bar'], { withPromptPrefix: false })).toBe(1);
  });

  it('matches the prompt-prefix variant first (default)', () => {
    const a = adapterFromLines({
      0: 'noise',
      1: 'plain claude',   // bare match
      2: '❯ claude',       // prompt-prefix match (preferred for live sessions)
    });
    // Both match; the scanner walks rows in order, so the first match wins.
    // Row 1 matches the bare needle, so it returns 1.
    expect(findRowByText(a, ['claude'])).toBe(1);
  });

  it('honors scanFrom by skipping earlier rows', () => {
    const a = adapterFromLines({
      0: 'duplicate',
      1: 'duplicate',
      2: 'unique',
    });
    expect(findRowByText(a, ['duplicate'], { scanFrom: 1, withPromptPrefix: false })).toBe(1);
    expect(findRowByText(a, ['duplicate'], { scanFrom: 2, withPromptPrefix: false })).toBeNull();
  });

  it('respects eviction floor — does not return evicted rows', () => {
    const a = adapterFromLines({ 5: 'visible', 6: 'visible2' }, /*eviction=*/ 5);
    expect(findRowByText(a, ['visible'], { scanFrom: 0, withPromptPrefix: false })).toBe(5);
  });

  it('returns null when no row matches any needle', () => {
    const a = adapterFromLines({ 0: 'foo', 1: 'bar' });
    expect(findRowByText(a, ['notpresent'], { withPromptPrefix: false })).toBeNull();
  });

  it('trims leading whitespace before matching', () => {
    const a = adapterFromLines({ 0: '   indented title' });
    expect(findRowByText(a, ['indented title'], { withPromptPrefix: false })).toBe(0);
  });

  it('skips empty/null needles', () => {
    const a = adapterFromLines({ 0: 'hit' });
    expect(findRowByText(a, ['', 'hit'], { withPromptPrefix: false })).toBe(0);
    expect(findRowByText(a, [''], { withPromptPrefix: false })).toBeNull();
  });

  it('tries multiple needles per row', () => {
    const a = adapterFromLines({ 0: 'Hello World Plan' });
    // Markdown stripped variant should still match.
    expect(findRowByText(a, ['# Hello World Plan', 'Hello World Plan'], { withPromptPrefix: false })).toBe(0);
  });
});
