/**
 * Translating at IMPORT time is the bug; this pins that it no longer happens.
 *
 * `HookEditor` built its `<Select>` options at module scope with
 * `i18n._(meta.title)`. Module evaluation runs before the real catalog is
 * activated (`i18n-init` deliberately activates an EMPTY catalog first so
 * import-time calls don't throw), so every option logged "Uncompiled message
 * detected" — ten of them per load — and, worse, the labels were frozen at
 * import: `locale-context`'s later `i18n.activate(...)` could never update them.
 *
 * The invariant is import-time silence. Asserting the rendered text instead
 * would not fail on the old code, because lingui falls back to the descriptor's
 * source message and the English strings come out looking correct either way.
 */
import { i18n } from '@lingui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('HookEditor — messages resolve at render, not at import', () => {
  it('translates nothing while the module is being imported', async () => {
    const underscore = vi.spyOn(i18n, '_');
    const t = vi.spyOn(i18n, 't');

    await import('@src/components/hooks-view/HookEditor');

    // Both spellings: `i18n._` is what the old module scope called, `i18n.t` is
    // what `useLingui()`'s `t` is bound to — neither may run before render.
    expect(underscore).not.toHaveBeenCalled();
    expect(t).not.toHaveBeenCalled();
  });

  it('holds for HooksTable too — the sibling this fix was modelled on', async () => {
    const underscore = vi.spyOn(i18n, '_');
    const t = vi.spyOn(i18n, 't');

    await import('@src/components/hooks-view/HooksTable');

    expect(underscore).not.toHaveBeenCalled();
    expect(t).not.toHaveBeenCalled();
  });
});
