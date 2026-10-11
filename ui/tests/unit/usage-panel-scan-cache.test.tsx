/**
 * UsagePanel — the module-scope scan cache is bounded.
 *
 * The cache exists so a remounted panel shows its last scan instead of an empty
 * prompt. It keeps the most recent scans only; a skill scanned longer ago than
 * that falls back to "Scan to find sessions" on its next mount.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@src/hooks/use-asset-revision-status', () => ({
  useAssetRevisionStatus: () => ({ revisions: [], version: null, unpushed: 0, hasRepo: false, refresh: () => {} }),
}));
vi.mock('@src/components/assets/editor/agent-trace/useAgentTraceDoc', () => ({
  useAgentTraceDoc: () => ({ doc: null }),
}));
vi.mock('@src/components/lens-viewer/shared/transcript-features/useSessionAnalyses', () => ({
  useSessionAnalyses: () => ({ traces: [] }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/lib/git-status-cache', () => ({
  getGitStatus: () => Promise.resolve({ files: [] }),
  invalidateGitStatus: () => {},
}));
vi.mock('@src/components/assets/editor/skill/skill-eval-analysis', () => ({
  launchSessionAnalysis: vi.fn(),
  launchSkillCorrect: vi.fn(),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  ActionInfo: class {
    queryParameters: { skill?: string } = {};
  },
  dataManager: {
    // One session per skill, labelled so the row identifies whose scan it is.
    callAction: (action: { queryParameters: { skill: string } }) =>
      Promise.resolve({
        sessions: [
          {
            sessionId: `sid-${action.queryParameters.skill}`,
            workerType: 'claude',
            count: 1,
            lastTs: '2026-01-01T00:00:00Z',
            name: `session of ${action.queryParameters.skill}`,
          },
        ],
      }),
  },
}));

import type { FSRef, Skill } from '@sdk';
import { MAX_CACHED_SCANS, UsagePanel } from '@src/components/assets/editor/skill/UsagePanel';

function mountPanel(name: string) {
  const skillFile = {
    localComputeNodeId: 'node-1',
    parent: { path: `/skills/${name}` },
    path: `/skills/${name}/SKILL.md`,
  } as unknown as FSRef;
  return render(<UsagePanel skill={{ name } as Skill} skillFile={skillFile} />);
}

/** Open the skill's panel, scan, and close it — what browsing a skill leaves behind. */
async function scanAndClose(name: string) {
  const { unmount } = mountPanel(name);
  fireEvent.click(screen.getByText('Scan usage'));
  await screen.findByText(`session of ${name}`);
  unmount();
}

/** True when a fresh mount shows the skill's last scan without scanning again. */
function remountShowsCachedScan(name: string): boolean {
  const { unmount } = mountPanel(name);
  const cached = screen.queryByText(`session of ${name}`) !== null;
  unmount();
  return cached;
}

describe('UsagePanel scan cache', () => {
  afterEach(cleanup);

  it('keeps the most recent scans and drops the older ones', async () => {
    const extra = 10;
    const names = Array.from({ length: MAX_CACHED_SCANS + extra }, (_, i) => `skill-${i}`);
    for (const name of names) await scanAndClose(name);

    const cached = names.filter(remountShowsCachedScan);
    expect(cached).toEqual(names.slice(extra));
  });

  it('a rescan makes a skill the most recent again', async () => {
    const names = Array.from({ length: MAX_CACHED_SCANS }, (_, i) => `again-${i}`);
    for (const name of names) await scanAndClose(name);
    await scanAndClose(names[0]);
    await scanAndClose('again-newcomer');

    expect(remountShowsCachedScan(names[0])).toBe(true);
    expect(remountShowsCachedScan(names[1])).toBe(false);
  });
});
