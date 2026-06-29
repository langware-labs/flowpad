import { i18n } from '@lingui/core';
import { DEFAULT_LOCALE } from '@src/contexts/locale-context';

/**
 * Synchronously activate a locale at module-evaluation time.
 *
 * Some components define module-level constants (e.g. config/label objects) that
 * call the Lingui `t` macro at import time — these run while the module graph is
 * being evaluated, BEFORE `initLocale()` (in main.tsx) activates the real
 * locale. Without an active locale, `i18n._` throws "Attempted to call a
 * translation function without setting a locale", which aborts the whole app
 * mount. Activating the source locale here (empty catalog → returns the source
 * msgid, i.e. the English source text) makes those import-time calls safe.
 *
 * This MUST be imported before any app module that uses Lingui macros — it is
 * the first import in main.tsx. The real, user-selected locale (incl. Hebrew)
 * is loaded + activated in `initLocale()` before first render.
 *
 * NOTE: strings captured by a module-level `t` are evaluated once at import and
 * will not react to later locale changes — those should use the lazy `msg`
 * macro instead. This guard only prevents the crash; see the i18n notes.
 */
i18n.activate(DEFAULT_LOCALE);
