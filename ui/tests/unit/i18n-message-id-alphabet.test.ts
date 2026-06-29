import { msg } from '@lingui/core/macro';
import { generateMessageId } from '@lingui/message-utils/generateMessageId';
import { describe, expect, it } from 'vitest';

/**
 * Regression: the two halves of Lingui's id pipeline must agree.
 *
 *  - `@lingui/swc-plugin` transforms the macros at the *call sites of the
 *    running app*, baking in the message id the app looks up at runtime.
 *  - `@lingui/message-utils` (used by `@lingui/cli` / `@lingui/vite-plugin`)
 *    keys the *compiled catalog* by id.
 *
 * If they hash to different ids for the same source string, the app asks for an
 * id the catalog doesn't have → the lookup misses → in production (where Lingui
 * strips the inline source fallback) the raw hash id renders instead of the
 * text.
 *
 * This actually happened: `@lingui/swc-plugin@6` switched to URL-safe base64
 * (`-`/`_`) while the v5 catalog toolchain stayed on standard base64 (`+`/`/`).
 * Every id containing a `+` or `/` then mismatched — e.g. "All": the app asked
 * for `N40H-G`, the catalog had `N40H+G` — so ~1 in 6 English strings rendered
 * as their hash ("N40H-G", "y_0uwd", …) in the Electron build.
 *
 * The assertions deliberately use strings whose canonical id contains a `+` and
 * a `/`. An all-alphanumeric id (e.g. "Inbox" → "Gp4Yi6") is byte-identical in
 * both alphabets and would NOT detect a drift — so those must not be the guard.
 */
describe('lingui message-id generation (swc-plugin ⇄ catalog compiler)', () => {
  it('swc-plugin ids match the catalog compiler, incl. ids with "+" and "/"', () => {
    // Guard the guard: confirm these references still exercise the URL-safe
    // characters. If Lingui ever changes the hash so they don't, fail loudly so
    // someone picks new anchor strings rather than the test going toothless.
    expect(generateMessageId('All')).toContain('+'); // N40H+G
    expect(generateMessageId('Yesterday')).toContain('/'); // y/0uwd

    // `msg` is compiled by @lingui/swc-plugin → `.id` is exactly what the app
    // resolves against the catalog. It MUST equal the catalog compiler's id.
    expect(msg`All`.id).toBe(generateMessageId('All'));
    expect(msg`Yesterday`.id).toBe(generateMessageId('Yesterday'));
  });
});
