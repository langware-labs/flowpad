import { i18n } from '@lingui/core';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Regression: the default (en-US) Lingui catalog must actually be loaded after
 * initLocale() runs.
 *
 * Proven root cause (RCA): loadAndActivate()'s guard
 *   `if (!i18n.messages || i18n.locale !== code) { ...load... }`
 * never fires for en-US. `i18n-init.ts` pre-activates en-US at import time, so
 * by the time initLocale() calls loadAndActivate('en-US'):
 *   - `!i18n.messages`        → `!{}`            → false  (empty object is truthy)
 *   - `i18n.locale !== code`  → 'en-US'!=='en-US'→ false
 * → the `import('../locales/en-US/messages.po')` is skipped and the en-US
 * catalog stays empty. In production builds Lingui strips the inline source
 * fallback, so every English string renders as its raw hash id
 * (e.g. "Gp4Yi6" instead of "Inbox") — what the user saw in the Electron app.
 *
 * This drives the REAL bootstrap (i18n-init → initLocale) and the REAL .po
 * catalog import — no mocks of the code under test.
 */
describe('en-US locale catalog loading (regression)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Force the default-locale code path deterministically. Setting localStorage
    // is a real input, not a mock of the loader — readInitialLocale() reads it.
    localStorage.setItem('locale', 'en-US');
  });

  it('loads the en-US catalog so the "Inbox" id resolves to English, not its hash', async () => {
    // Real startup order: i18n-init pre-activates en-US (empty catalog), then
    // initLocale() should load + activate the real en-US catalog.
    await import('@src/i18n-init');
    const { initLocale } = await import('@src/contexts/locale-context');
    await initLocale();

    // "Gp4Yi6" is the compiled Lingui id for the source string "Inbox"
    // (confirmed in the built catalog: "Gp4Yi6":["Inbox"]). With the catalog
    // loaded this resolves to "Inbox"; with the bug it returns the id itself.
    expect(i18n._({ id: 'Gp4Yi6' })).toBe('Inbox');
    // Durable assertion independent of the specific hash: the active en-US
    // catalog must be non-empty.
    expect(Object.keys(i18n.messages).length).toBeGreaterThan(0);
  });
});
