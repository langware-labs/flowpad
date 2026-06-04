import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// Source-contract test pinning the prompt-library layer borders
// (docs/prompt-library.md): the feature is PURE COMPOSITION — folders come
// entirely from the generic groups layer, prompt→queue is one SDK call, and
// icon/color come from the GENERIC pickers.
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8');

const menuSource = read('../../src/components/prompt-library/PromptLibraryMenu.tsx');
const dialogSource = read('../../src/components/prompt-library/PromptEditDialog.tsx');
const ribbonSource = read(
  '../../src/components/terminal/interactive-terminal/TerminalBottomRibbon.tsx',
);
const sdkPromptSource = read('../../../ts_sdk/src/entities/prompt.ts');

describe('prompt library is pure composition (zero logic)', () => {
  it('menu composes the GENERIC groups adapter — no folder logic of its own', () => {
    expect(menuSource).toContain('groupRoot');
    expect(menuSource).toContain("'prompt-library'");
    // no folder mechanics implemented here — they live in the generic layer
    expect(menuSource).not.toMatch(/Group\.create|deleteGroup|\.move\(|setGroup/);
    expect(menuSource).not.toMatch(/fetch\(|apiClient|QueryRequest/);
  });

  it('prompt→queue is exactly the SDK call', () => {
    expect(menuSource).toContain('.enqueueTo(process)');
    // never touches the queue actions/file directly
    expect(menuSource).not.toMatch(/enqueue\(|clear-queue|set-queue-enabled|prompt_queue/);
  });

  it('the SDK enqueueTo rides the existing queue path with source=library', () => {
    expect(sdkPromptSource).toContain("process.enqueue(this.text ?? '', 'library')");
  });

  it('add/edit dialog uses the GENERIC pickers and one SDK call', () => {
    expect(dialogSource).toContain("from '@src/components/ui/color-picker'");
    expect(dialogSource).toContain("from '@src/components/ui/icon-picker'");
    expect(dialogSource).toContain('Prompt.create');
    expect(dialogSource).not.toMatch(/fetch\(|apiClient/);
    // contrast safety comes from the curated palette, not dialog math
    expect(dialogSource).not.toMatch(/relativeLuminance|contrastRatio|hexToRgb/);
  });

  it('ribbon exposes the Queue tab and the distinct Prompt Library button', () => {
    expect(ribbonSource).toContain('SideTabId.Queue');
    expect(ribbonSource).toContain('PromptLibraryMenu');
    expect(ribbonSource).toContain('Prompt Library');
  });
});
