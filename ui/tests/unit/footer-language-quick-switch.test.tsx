/**
 * The footer's language button is a QUICK switch: it shows only when the user
 * and the app share 2+ languages. "The user's languages" is
 * `navigator.languages` ∪ the backend's `user_languages` — OS display languages
 * AND keyboard layouts, which the browser cannot see.
 *
 * The case that motivated it: an English-only Windows (one language in common)
 * showed a language menu nobody there could use.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanguageSelector } from '@src/components/footer/LanguageSelector';
import { applySupportedLocales } from '@src/contexts/locale-context';

const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', dir: 'rtl' as const, flag: 'sa' },
];

const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');

function setNavigatorLanguages(langs: string[]) {
  Object.defineProperty(navigator, 'languages', { value: langs, configurable: true });
}

beforeEach(() => {
  // Pin the UI to English: with Hebrew first in `navigator.languages` the first-run pick would
  // switch the catalog, and the button's accessible name with it. The rule under test is WHEN
  // the button shows, not which language it speaks.
  localStorage.setItem('locale', 'en-US');
});

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).languages;
  if (original) Object.defineProperty(Navigator.prototype, 'languages', original);
});

describe('footer quick language switch', () => {
  it('is hidden when the user shares only English with the app', async () => {
    setNavigatorLanguages(['en-US']);
    await applySupportedLocales(LOCALES, ['en-US']);
    render(<LanguageSelector />);
    expect(screen.queryByRole('button', { name: /change language/i })).toBeNull();
  });

  it('shows for a Hebrew keyboard on an English OS (keyboard layouts count)', async () => {
    setNavigatorLanguages(['en-US']);
    // What the backend reports for an English macOS with a Hebrew keyboard.
    await applySupportedLocales(LOCALES, ['he']);
    render(<LanguageSelector />);
    expect(screen.getByRole('button', { name: /change language/i })).toBeTruthy();
  });

  it('shows when the browser alone reports two shared languages', async () => {
    setNavigatorLanguages(['he-IL', 'en-US']);
    await applySupportedLocales(LOCALES, []);
    render(<LanguageSelector />);
    expect(screen.getByRole('button', { name: /change language/i })).toBeTruthy();
  });

  it('does not count languages the app does not ship', async () => {
    setNavigatorLanguages(['en-US', 'fr-FR']);
    await applySupportedLocales(LOCALES, ['de']);
    render(<LanguageSelector />);
    expect(screen.queryByRole('button', { name: /change language/i })).toBeNull();
  });
});
