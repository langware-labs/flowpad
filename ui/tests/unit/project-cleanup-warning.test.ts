/**
 * The path from a scan result to the footer warning.
 *
 * The store is the only thing between the backend's counts and the warning, so
 * these drive the real store rather than asserting on a hand-built warning
 * object — the interesting failures live in the ingestion, not the factory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCleanupStoreForTest,
  getCleanupSummary,
  ingestCleanupSummary,
  shouldWarnAboutEmptyProjects,
  subscribeToCleanupSummary,
} from '@sdk/stores/project-cleanup-store';
import { createEmptyProjectsWarning, WARNING_IDS } from '@sdk/models/UserWarning';
import { ViewType } from '@sdk/utils/ui/view-types';

const summary = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
const base = () => ({
  empty_count: 0,
  orphaned_count: 0,
  stale_count: 0,
  empty_size_bytes: 0,
  threshold: 10,
});

describe('cleanup summary store', () => {
  beforeEach(() => {
    __resetCleanupStoreForTest();
  });

  it('holds nothing until a scan has run', () => {
    expect(getCleanupSummary()).toBeNull();
    expect(shouldWarnAboutEmptyProjects(getCleanupSummary())).toBe(false);
  });

  it('takes the counts from a scan result', () => {
    ingestCleanupSummary(summary({ empty_count: 570, orphaned_count: 49 }));
    expect(getCleanupSummary()?.empty_count).toBe(570);
  });

  it('warns strictly above the threshold, never at it', () => {
    ingestCleanupSummary(summary({ empty_count: 10 }));
    expect(shouldWarnAboutEmptyProjects(getCleanupSummary())).toBe(false);

    ingestCleanupSummary(summary({ empty_count: 11 }));
    expect(shouldWarnAboutEmptyProjects(getCleanupSummary())).toBe(true);
  });

  it('reads the threshold from the payload rather than a local constant', () => {
    // The backend owns the policy. A payload that raises the bar must raise it
    // here too, with no frontend change.
    ingestCleanupSummary(summary({ empty_count: 50, threshold: 100 }));
    expect(shouldWarnAboutEmptyProjects(getCleanupSummary())).toBe(false);
  });

  it('ignores a response with no cleanup block instead of clearing the warning', () => {
    // An older backend sends nothing. That is not "zero candidates", and
    // dropping the count would silently retract a warning the user should see.
    ingestCleanupSummary(summary({ empty_count: 570 }));
    ingestCleanupSummary(undefined);
    expect(getCleanupSummary()?.empty_count).toBe(570);
  });

  it('does not notify subscribers when the counts are unchanged', () => {
    // The project list refetches often; re-rendering every warning consumer on
    // an identical result is work nobody asked for.
    const listener = vi.fn();
    subscribeToCleanupSummary(listener);

    ingestCleanupSummary(summary({ empty_count: 5 }));
    expect(listener).toHaveBeenCalledTimes(1);

    ingestCleanupSummary(summary({ empty_count: 5 }));
    expect(listener).toHaveBeenCalledTimes(1);

    ingestCleanupSummary(summary({ empty_count: 6 }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeToCleanupSummary(listener);
    off();
    ingestCleanupSummary(summary({ empty_count: 5 }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('empty-projects warning', () => {
  it('points at the cleanup lens so one click opens it', () => {
    // The popover routes targetView + targetPointer through openDock with no
    // special-casing, so these two fields ARE the click behaviour.
    const warning = createEmptyProjectsWarning(570);
    expect(warning.id).toBe(WARNING_IDS.EMPTY_PROJECTS);
    expect(warning.targetView).toBe(ViewType.LENS);
    expect(warning.targetPointer).toBe('projects/cleanup');
  });

  it('names the count in the message', () => {
    expect(createEmptyProjectsWarning(570).message).toContain('570');
  });

  it('is informational, not an alarm', () => {
    // Nothing is broken and nothing is at risk; an orange/red warning here
    // would be crying wolf next to genuine connection failures.
    expect(createEmptyProjectsWarning(570).color).toBe('gray');
  });
});
