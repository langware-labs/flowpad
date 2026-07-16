import { describe, expect, it } from 'vitest';
import { shouldShowIndexPrompt } from '@src/components/assets/asset-body-content';

/**
 * Regression: clicking the rails project icon opened /dock/assets/project-home,
 * where the index status is read unscoped (global) — so on a never-indexed
 * instance `neverIndexed` was true and, in Advanced view, the Build Index
 * prompt hid project home entirely.
 *
 * The invariant: the index prompt never preempts the project-home landing.
 */
describe('shouldShowIndexPrompt', () => {
  it('never shows the prompt in project-home mode — the bug', () => {
    // The exact reproduced state: never-indexed, Advanced, project-home landing.
    // Project home must win; without the guard this returned true (Build Index).
    expect(
      shouldShowIndexPrompt({ neverIndexed: true, isAdvanced: true, isProjectHomeMode: true }),
    ).toBe(false);
  });

  it('shows the prompt while browsing assets when nothing is indexed (Advanced)', () => {
    expect(
      shouldShowIndexPrompt({ neverIndexed: true, isAdvanced: true, isProjectHomeMode: false }),
    ).toBe(true);
  });

  it('is Advanced-only — lower modes show their own surface, never the prompt', () => {
    expect(
      shouldShowIndexPrompt({ neverIndexed: true, isAdvanced: false, isProjectHomeMode: false }),
    ).toBe(false);
  });

  it('does not show the prompt once something is indexed', () => {
    expect(
      shouldShowIndexPrompt({ neverIndexed: false, isAdvanced: true, isProjectHomeMode: false }),
    ).toBe(false);
  });
});
