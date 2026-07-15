import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted, so shared state must use vi.hoisted
const { mockDataContext, mockFromMachinePath, mockForFile } = vi.hoisted(() => ({
  mockDataContext: { computeNode: null as any },
  mockFromMachinePath: vi.fn(),
  mockForFile: vi.fn((path: string) => ({ type: 'file', path })),
}));

// Only mock the specific parts of @sdk that need to be controllable —
// dataContext (a MobX computed that cannot be spied on) and VFSPath.fromMachinePath.
// All other SDK exports remain real.
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  dataContext: mockDataContext,
  VFSPath: { fromMachinePath: mockFromMachinePath },
}));

vi.mock('@src/navigation/DockPointer', () => ({
  DockPointer: { forFile: mockForFile },
}));

import { getAnalysisPath, openAnalysisReport } from '@src/components/task-bar/task-utils';

beforeEach(() => {
  vi.clearAllMocks();
  mockDataContext.computeNode = null;
});

// ---------- getAnalysisPath ----------

describe('getAnalysisPath', () => {
  it('returns the path for a non-analysis task stamped by an analysis flow', () => {
    // No task_type gate: analysis_path is only ever written by analysis-producing
    // flows (e.g. the Analyze Status wizard on regular tasks).
    expect(getAnalysisPath({ task_type: 'bug', analysis_path: '/p' } as any)).toBe('/p');
  });

  it('returns null when analysis_path is missing', () => {
    expect(getAnalysisPath({ task_type: 'analysis' } as any)).toBeNull();
  });

  it('returns the path for a valid analysis task', () => {
    const task = { task_type: 'analysis', analysis_path: '/home/.flow/sessions/abc/analysis.md' };
    expect(getAnalysisPath(task as any)).toBe('/home/.flow/sessions/abc/analysis.md');
  });
});

// ---------- openAnalysisReport ----------

describe('openAnalysisReport', () => {
  // Reports open through navigation.openFile — the shared type-dispatch
  // chokepoint (an .md report lands in the assets document viewer, not the
  // raw code editor).
  it('opens via VFS path when computeNode is available', () => {
    const fakeTypeId = { toString: () => 'compute_node-@local' };
    mockDataContext.computeNode = { typeId: fakeTypeId };
    mockFromMachinePath.mockReturnValue({ absVfsPath: 'compute_node-@local/home/analysis.md' });

    const navigation = { openFile: vi.fn() } as any;
    openAnalysisReport('/home/analysis.md', navigation);

    expect(mockFromMachinePath).toHaveBeenCalledWith('/home/analysis.md', fakeTypeId);
    expect(navigation.openFile).toHaveBeenCalledWith('compute_node-@local/home/analysis.md');
  });

  it('falls back to raw path when computeNode is unavailable', () => {
    mockDataContext.computeNode = null;

    const navigation = { openFile: vi.fn() } as any;
    openAnalysisReport('/fallback/path.md', navigation);

    expect(mockFromMachinePath).not.toHaveBeenCalled();
    expect(navigation.openFile).toHaveBeenCalledWith('/fallback/path.md');
  });
});
