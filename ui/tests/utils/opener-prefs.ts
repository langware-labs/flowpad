import { instancePreferences, PrefKey } from '@sdk';

/**
 * Reset the registry-driven opener-memory preferences that WorkerToolbar /
 * usePinnedOpeners persist (PrefKey.LAST_OPENER + PINNED_OPENERS), so each test
 * starts with `claude_code` as the primary worker and no pinned openers. The
 * instancePreferences singleton persists across tests, so this must run in
 * beforeEach/afterEach — otherwise a test that launches codex leaks
 * codex-primary into the next.
 */
export function resetOpenerPrefs(): void {
  instancePreferences.set(PrefKey.LAST_OPENER, null);
  instancePreferences.set(PrefKey.PINNED_OPENERS, []);
}
