import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const ribbonSource = readFileSync(
  resolve(__dirname, '../../src/components/terminal/interactive-terminal/TerminalBottomRibbon.tsx'),
  'utf-8',
);

const hookSource = readFileSync(
  resolve(__dirname, '../../src/hooks/useAgenticQueue.ts'),
  'utf-8',
);

describe('Queue entries null guard', () => {
  it('TerminalBottomRibbon uses null-safe access for queue.entries.length', () => {
    // The raw access queue.entries.length crashes when entries is undefined.
    // It must use (queue.entries ?? []).length or queue.entries?.length.
    expect(ribbonSource).not.toMatch(/queue\.entries\.length/);
  });

  it('useAgenticQueue idle injection uses null-safe access for queue.entries.length', () => {
    // Line 80: queue.entries.length > 0 crashes when entries is undefined.
    // Must be guarded.
    expect(hookSource).not.toMatch(/queue\.entries\.length/);
  });
});
