/**
 * Skill edit round-trip — SDK create → edit in the REAL app UI → SDK read-back.
 *
 * No mocks. The full app boots in jsdom against a live backend (same realm trick
 * as full_app_smoke). Steps:
 *   1. Create a Skill purely via the SDK (`Skill.create` → real HTTP save).
 *   2. Open the app and navigate to that skill's editor route.
 *   3. Edit it THROUGH THE UI — click the editor's eval toggle
 *      (`data-testid="skill-eval-toggle"`), which flips `skill.metadata.eval`
 *      and persists via the editor's real `skill.save()` path.
 *   4. Fetch the skill again via the SDK (`Skill.getById`) and assert the edit
 *      is visible (`isEval` flipped).
 *
 * The eval toggle is used as the "edit" because it's a deterministic, jsdom-safe
 * control that round-trips through the SDK — unlike typing into the Milkdown/
 * Monaco body, which needs real layout/canvas (that's Playwright territory).
 *
 * Prereq: an explicitly selected disposable instance_ctl backend.
 * Run: `cd ui && FLOW_INSTANCE=<disposable-name> npm run test:vitest:headless`
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { setupLiveBackend, bootApp } from './_harness';
import { trackForCleanup, testEntityName } from '../_cleanup';
import { createSdkRealm } from '../_sdk_realm';

const backend = setupLiveBackend('[skill edit]');

describe('skill edit round-trip via the UI (no mocks)', () => {
  it('SDK-create → open in app → toggle eval in UI → SDK-refetch sees the edit', async () => {
    const live = backend.current;
    if (!live) throw new Error('headless backend preflight did not resolve FLOW_INSTANCE');

    const t0 = performance.now();
    const mark = (label: string) => `${label} @ +${((performance.now() - t0) / 1000).toFixed(2)}s`;

    // Point the realm at the live backend and (re-)evaluate the SDK graph so the
    // skill we create and the app we boot share ONE realm bound to this backend.
    const { sdk } = await createSdkRealm(live.apiUrl);
    await sdk.initSdk();
    console.log(mark(`[skill edit] realm booted against ${live.apiUrl}`));

    // 1. Create the skill purely via the SDK.
    const name = testEntityName('skill');
    const created = trackForCleanup(await sdk.Skill.create(name, 'created by the app edit round-trip test'));
    const id = created.id;
    expect(id).toBeTruthy();
    console.log(mark(`[skill edit] created skill ${id} (isEval=${created.isEval})`));

    // Teardown is handled by the cleanup registry (trackForCleanup above →
    // installCleanup's afterEach in headless/_setup.ts): it full-purges the
    // skill (row + asset_ref folder) on pass OR fail. No in-band delete here —
    // a plain delete() leaves the on-disk folder, which the indexer would
    // re-surface (see ../_cleanup.ts).

    // The eval toggle lives in the markdown editor's Advanced-only header slot
    // (MarkdownEditor renders `{advanced && nameExtras}`; the toggle is in
    // nameExtras). Skill-management controls only surface in Advanced view
    // mode, so drive the app there — set on the SAME realm bootApp will mount,
    // before any render, via the context's own API (no hardcoded storage key).
    const { setViewMode, ViewMode } = await import('@src/contexts/view-mode-context');
    setViewMode(ViewMode.Advanced);

    // 2. Open the full app (router fresh from the same realm) and navigate to
    //    this skill's editor.
    const { container, router } = await bootApp();
    console.log(mark('[skill edit] app booted'));

    const { DockPointer } = await import('@src/navigation/DockPointer');
    const editorUrl = DockPointer.forAssetEditorByTypeId('skill', new sdk.TypeId('skill', id)).toUrl();

    await act(async () => {
      await router.navigate(editorUrl);
    });

    // 3. The skill editor mounted → its eval toggle is present.
    let toggle: HTMLElement;
    try {
      toggle = await screen.findByTestId(
        'skill-eval-toggle',
        {},
        { timeout: 18000 }, // do not increase timeout without approval
      );
    } catch (e) {
      const testids = Array.from(container.querySelectorAll('[data-testid]'))
        .map((el) => el.getAttribute('data-testid'))
        .slice(0, 40);
      console.error('[skill edit][DEBUG] toggle not found. data-testids on screen:', testids);
      console.error(
        '[skill edit][DEBUG] headings:',
        screen.queryAllByRole('heading').map((h) => h.textContent),
      );
      console.error('[skill edit][DEBUG] body text (first 800):', (container.textContent ?? '').slice(0, 800));
      throw e;
    }
    const before = toggle.getAttribute('aria-pressed') === 'true';
    console.log(mark(`[skill edit] editor open, eval toggle present (pressed=${before})`));

    // 4. Edit via the UI: click the toggle.
    fireEvent.click(toggle);

    // The UI reflects the flip immediately (optimistic frontmatter + entity save).
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe(String(!before)));
    console.log(mark('[skill edit] toggled in UI'));

    // 5. Fetch the skill again via the SDK and validate the edit is visible.
    await waitFor(
      async () => {
        const refetched = await sdk.Skill.getById(id);
        expect(refetched?.isEval).toBe(!before);
      },
      { timeout: 15000 }, // do not increase timeout without approval
    );

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`[skill edit] ✅ round-trip validated: eval ${before} → ${!before}; total ${elapsed}s`);
  });
});
