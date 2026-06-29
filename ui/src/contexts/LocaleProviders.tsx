import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { DirectionProvider } from '@radix-ui/react-direction';
import type { ReactNode } from 'react';
import { useLocaleInfo } from './locale-context';

/**
 * Wraps the app in the two i18n-aware providers:
 *
 *  - `I18nProvider` makes the shared `i18n` instance available to Lingui's
 *    runtime (`<Trans/>`, `useLingui`) and re-renders children when the active
 *    catalog changes (it subscribes to `i18n`'s change event, so `setLocale`
 *    propagates automatically).
 *  - Radix `DirectionProvider` feeds `dir` into all portalled Radix primitives
 *    (menus, popovers, dropdowns, tooltips, selects) which otherwise escape the
 *    `<html dir>` cascade. Driven by `useLocaleInfo().dir` so it tracks locale changes.
 */
export function LocaleProviders({ children }: { children: ReactNode }) {
  const dir = useLocaleInfo().dir;
  return (
    <I18nProvider i18n={i18n}>
      <DirectionProvider dir={dir}>{children}</DirectionProvider>
    </I18nProvider>
  );
}
