/**
 * Rendered markdown must take its base direction from what a block ACTUALLY
 * contains, not from the block's first strong character (FLOWPAD-2015).
 *
 * The renderer used to stamp `dir="auto"` on every block, which failed twice
 * in a Hebrew-locale app:
 *
 *   1. `dir="auto"` reads the FIRST STRONG CHARACTER. A Hebrew list item that
 *      merely opens with an English term — `Persian – חתול רגוע…` — has a Latin
 *      first-strong char, so the item flipped LTR: marker on the left, the
 *      Hebrew running the wrong way.
 *   2. HTML's `dir="auto"` skips the text of descendant subtrees that carry
 *      their own `dir`. With `dir="auto"` on `<li>` too, the `<ol>` could see
 *      none of its items, found no strong character, and defaulted to LTR —
 *      for EVERY list, all-Hebrew ones included. `ms-6` then resolved to
 *      `margin-left` and the list indented from the wrong side.
 *
 * These assert the emitted `dir` attributes, which is the lever: `dir` is what
 * CSS `direction` — and with it the marker side and `ms-*` — resolves from.
 * jsdom does no layout, so the geometry itself is verified in the browser.
 */
import { render } from '@testing-library/react';
import { instancePreferences, PrefKey } from '@sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { applySupportedLocales } from '@src/contexts/locale-context';
import { MarkdownView } from '@src/components/markdown-view';

const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
];

/** Put the app in `code` the way a real session is in it, list included. */
async function useLocale(code: string): Promise<void> {
  localStorage.setItem('locale', code);
  instancePreferences.set(PrefKey.LOCALE, code);
  await applySupportedLocales(LOCALES);
}

afterEach(async () => {
  await useLocale('en-US');
});

describe('markdown block direction', () => {
  it('keeps a Hebrew list RTL when every item opens with an English term', async () => {
    await useLocale('he');
    // The exact shape the ticket reproduced with: "<breed in English> – <description in Hebrew>".
    const { container } = render(
      <MarkdownView
        value={[
          '1. Persian - חתול רגוע ובעל פרווה ארוכה ועשירה, עם פרצוף שטוח ואופי שליו.',
          '2. Maine Coon - אחד מגזעי החתולים הגדולים בעולם, ידידותי וחברותי.',
        ].join('\n')}
      />,
    );

    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    // Was "ltr": the Latin first-strong char decided a line of Hebrew.
    expect(ol?.getAttribute('dir')).toBe('rtl');
  });

  it('keeps an all-Hebrew list RTL — the list element itself, not just its items', async () => {
    await useLocale('he');
    const { container } = render(<MarkdownView value={'1. אחת\n2. שתיים\n3. שלוש'} />);

    const ol = container.querySelector('ol');
    // Was "ltr" even here: `dir="auto"` on the <li> children blinded the <ol>,
    // so `ms-6` indented the list from the left in a right-to-left app.
    expect(ol?.getAttribute('dir')).toBe('rtl');
  });

  it('keeps a Hebrew glossary list RTL though the English glosses are the longer words', async () => {
    await useLocale('he');
    // Counting CHARACTERS gets this wrong — Latin outnumbers Hebrew here
    // (44 to 33) purely because Hebrew writes the same words more compactly.
    const { container } = render(
      <MarkdownView
        value={['1. פרסי (Persian)', '2. מיין קון (Maine Coon)', '3. בריטי קצר שיער (British Shorthair)'].join('\n')}
      />,
    );

    expect(container.querySelector('ol')?.getAttribute('dir')).toBe('rtl');
  });

  it('does not stamp dir on <li>, so every marker stays on the same side', async () => {
    await useLocale('he');
    // Predominantly Hebrew, with one item that is entirely English.
    const { container } = render(
      <MarkdownView value={'- פריט ראשון בעברית עם טקסט ארוך יחסית\n- פריט שני בעברית\n- Entirely English item'} />,
    );

    const ul = container.querySelector('ul');
    expect(ul?.getAttribute('dir')).toBe('rtl');
    // An <li> with its own dir puts ITS marker on ITS start side; one English
    // item would then hang its bullet on the opposite side of the others.
    for (const li of container.querySelectorAll('li')) {
      expect(li.getAttribute('dir')).toBeNull();
    }
  });

  it('keeps a mostly-Hebrew paragraph RTL when it begins in English', async () => {
    await useLocale('he');
    const { container } = render(<MarkdownView value="Persian - חתול רגוע ובעל פרווה ארוכה ועשירה ואופי שליו." />);

    expect(container.querySelector('p')?.getAttribute('dir')).toBe('rtl');
  });

  it('still renders a genuinely English paragraph LTR inside a Hebrew app', async () => {
    await useLocale('he');
    const { container } = render(<MarkdownView value="The quick brown fox jumps over the lazy dog." />);

    expect(container.querySelector('p')?.getAttribute('dir')).toBe('ltr');
  });

  it('still renders Hebrew content RTL inside an English app', async () => {
    // The reason `dir="auto"` was there in the first place — content direction
    // must keep beating the UI locale, or this fix would trade one bug for another.
    await useLocale('en-US');
    const { container } = render(<MarkdownView value={'שלום עולם\n\n1. אחת\n2. שתיים'} />);

    expect(container.querySelector('p')?.getAttribute('dir')).toBe('rtl');
    expect(container.querySelector('ol')?.getAttribute('dir')).toBe('rtl');
  });

  it('falls back to the app locale when a block has no strong characters', async () => {
    await useLocale('he');
    const { container } = render(<MarkdownView value="42 — 17 (99%)" />);

    // `dir="auto"` had no locale to fall back on and always answered LTR here.
    expect(container.querySelector('p')?.getAttribute('dir')).toBe('rtl');
  });

  it('ignores code when weighing a block, so one inline token cannot flip it', async () => {
    await useLocale('he');
    const { container } = render(<MarkdownView value="הרץ את `npm run dev --workspace ui` ואז פתח." />);

    expect(container.querySelector('p')?.getAttribute('dir')).toBe('rtl');
  });
});
