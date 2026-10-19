/**
 * The React-side text DIRECTION must survive the boot ORDER.
 *
 * `main.tsx` renders the tree (and with it `LocaleProviders` → Radix
 * `DirectionProvider`) BEFORE the root loader calls `applySupportedLocales` with
 * the backend's list. Until that lands, the only supported locale is the en-US
 * fallback, so a stored `he` reads as unsupported and `useLocale()` answers
 * `en-US` — correctly, for that instant.
 *
 * The bug this pins: the list is a SECOND reactive store, and `useLocale` used
 * to read it without subscribing. The preference never changes afterwards (it
 * was already `he`), so nothing re-rendered and the React answer stayed `en-US`
 * for the whole session — while `<html dir>`, written imperatively, went `rtl`.
 * Every Radix primitive that stamps its own `dir` (Tabs.Root) then pinned its
 * subtree LTR against the document: the Hebrew project page rendered its tab
 * body — headings, tab pills, the whole tile grid — flush left.
 */
import { render, waitFor } from '@testing-library/react';
import { instancePreferences, PrefKey } from '@sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import { applySupportedLocales, useLocaleInfo } from '@src/contexts/locale-context';

const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
];

/** Stands in for `LocaleProviders`, which feeds exactly this into Radix. */
function DirProbe() {
  return <span data-testid="dir">{useLocaleInfo().dir}</span>;
}

describe('direction after the supported-locale list arrives', () => {
  beforeAll(() => {
    // The state a returning Hebrew reader boots in: the choice is already
    // stored (both mirrors), and the backend list has NOT arrived yet.
    localStorage.setItem('locale', 'he');
    instancePreferences.set(PrefKey.LOCALE, 'he');
  });

  it('re-renders from ltr to rtl when the list lands, with no preference change', async () => {
    const { getByTestId } = render(<DirProbe />);
    // Pre-bootstrap: `he` is not supported yet, so en-US/ltr is the right answer.
    expect(getByTestId('dir').textContent).toBe('ltr');

    // The root loader's post-bootstrap step. The PREFERENCE is untouched here —
    // only the supported list changes, which is the whole point.
    await applySupportedLocales(LOCALES);

    await waitFor(() => expect(getByTestId('dir').textContent).toBe('rtl'));
  });
});
