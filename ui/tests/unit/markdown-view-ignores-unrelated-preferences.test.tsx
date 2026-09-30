/**
 * A view-mode flip must not re-render (and re-parse) every markdown message (FLOWPAD-2193).
 *
 * Reported on the dev instance: flipping a 600-row session between Chat and Terminal took
 * 2.5-4.5 s EVERY time, not just the first. The profile showed 600 `MarkdownView` + 600
 * `Markdown` rendering per flip. `MarkdownView` reads the locale direction through
 * `useLocale`, which read `usePreference(LOCALE)` — and `usePreference` binds to the
 * store's version counter, so it re-renders on ANY preference change. The flip saves the
 * view mode, which is a preference.
 *
 * OBSERVATION POINT — React's own `<Profiler>`: `onRender` fires only when something in the
 * profiled subtree actually rendered, so a count that does not move IS "did not re-render".
 * The real `MarkdownView`, the real preference store; nothing is mocked.
 */
import { act, render, renderHook } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { instancePreferences, PrefKey } from '@sdk';
import { usePreferenceValue } from '@sdk/react/hooks/use-preference';
import { applySupportedLocales } from '@src/contexts/locale-context';
import { MarkdownView } from '@src/components/markdown-view';

const LOCALES = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr' as const, flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl' as const, flag: 'il' },
];

async function inLocale(code: string): Promise<void> {
  localStorage.setItem('locale', code);
  instancePreferences.set(PrefKey.LOCALE, code);
  await applySupportedLocales(LOCALES);
}

afterEach(async () => {
  instancePreferences.set(PrefKey.VIEW_MODE, 'standard');
  await inLocale('en-US');
});

describe('a preference other than the locale changes', () => {
  it('does not re-render a markdown message', async () => {
    await inLocale('en-US');
    let renders = 0;
    render(
      <Profiler id="md" onRender={() => (renders += 1)}>
        <MarkdownView value={'## A reply\n\nSome **bold** text and a list:\n\n- one\n- two'} />
      </Profiler>,
    );
    const afterMount = renders;

    act(() => instancePreferences.set(PrefKey.VIEW_MODE, 'advanced'));
    act(() => instancePreferences.set(PrefKey.VIEW_MODE, 'standard'));

    expect(renders, 'a view-mode change re-rendered a markdown message').toBe(afterMount);
  });

  it('still re-renders it when the locale itself changes', async () => {
    await inLocale('en-US');
    let renders = 0;
    render(
      <Profiler id="md" onRender={() => (renders += 1)}>
        <MarkdownView value={'שלום עולם'} />
      </Profiler>,
    );
    const afterMount = renders;

    await act(async () => {
      await inLocale('he');
    });

    expect(renders, 'a locale change did not reach the markdown message').toBeGreaterThan(afterMount);
  });
});

describe('usePreferenceValue', () => {
  it('re-renders only for its own key', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePreferenceValue<string>(PrefKey.VIEW_MODE);
    });
    const afterMount = renders;

    act(() => instancePreferences.set(PrefKey.LOCALE, 'en-US'));
    expect(renders, 'an unrelated preference re-rendered the reader').toBe(afterMount);

    act(() => instancePreferences.set(PrefKey.VIEW_MODE, 'advanced'));
    expect(result.current).toBe('advanced');
    expect(renders, 'its own preference did not re-render the reader').toBeGreaterThan(afterMount);
  });
});
