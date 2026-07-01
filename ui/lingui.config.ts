import type { LinguiConfig } from '@lingui/conf';

/**
 * Lingui i18n configuration.
 *
 * Source locale is en-US (strings authored inline in components via macros).
 * `ar` / `he` are the RTL proof locales; the per-locale text *direction* is NOT
 * configured here — it lives in `src/contexts/locale-context.tsx`
 * (SUPPORTED_LOCALES), which is the single writer of `<html dir>`.
 *
 * `en-XA` is a pseudo-locale generated from the source catalog: accented +
 * inflated text used in dev to surface un-wrapped (hardcoded) strings and
 * layout/truncation bugs before any real translation exists.
 */
const config: LinguiConfig = {
  locales: ['en-US', 'ar', 'he'],
  sourceLocale: 'en-US',
  pseudoLocale: 'en-XA',
  fallbackLocales: {
    'en-XA': 'en-US',
    default: 'en-US',
  },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['<rootDir>/src'],
    },
  ],
  format: 'po',
  // Keep the `#: file.tsx` source references but drop the volatile `:<line>`
  // suffix. Line numbers shift on any edit, so `lingui extract` (run by
  // `npm run build`) would otherwise rewrite hundreds of location comments on
  // every build — a huge diff with no real string changes. File paths still
  // move meaningfully when a string is added/removed/relocated.
  formatOptions: { lineNumbers: false },
};

export default config;
