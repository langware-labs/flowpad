/**
 * The per-runtime appearance table worn by the nav bar's runtime chip.
 *
 * This is a safety signal — on a cloud sandbox or an agent's box the color is
 * how you know whose machine you are looking at — so the table must cover every
 * runtime and must actually reach the CSS. (Inherited from the environment
 * banner these classes used to style; the banner is gone, the contract isn't.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { RuntimeKind } from '@sdk';
import { RUNTIME_APPEARANCE, RUNTIME_CLASS } from '@src/components/top-nav-bar/runtime-appearance';

describe('the runtime appearance table', () => {
  it('covers every runtime kind with a color, a glyph and a wiki heading', () => {
    for (const kind of Object.values(RuntimeKind)) {
      const a = RUNTIME_APPEARANCE[kind];
      expect(a?.className, `no color for ${kind}`).toBeTruthy();
      expect(a?.base, `no glyph for ${kind}`).toBeTruthy();
      expect(a?.heading, `no wiki heading for ${kind}`).toBeTruthy();
      expect(RUNTIME_CLASS[kind]).toBe(a.className);
    }
  });

  it('forces its foreground so a host style cannot win', () => {
    for (const [kind, className] of Object.entries(RUNTIME_CLASS)) {
      expect(className, `${kind} must force its text color`).toMatch(/!text-/);
    }
  });

  it('spells every class as a source literal so Tailwind emits it', () => {
    // Tailwind scans source TEXT. A class assembled by string surgery is never
    // written to the CSS, and the chip would render unstyled — invisible signal,
    // no error anywhere. Assert each token appears verbatim in the file.
    const source = readFileSync(
      resolve(__dirname, '../../src/components/top-nav-bar/runtime-appearance.ts'),
      'utf8',
    );
    for (const className of Object.values(RUNTIME_CLASS)) {
      for (const token of className.split(/\s+/).filter(Boolean)) {
        expect(source.includes(token), `"${token}" is not a literal in runtime-appearance.ts`).toBe(true);
      }
    }
  });
});
