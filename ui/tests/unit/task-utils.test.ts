import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getAnalysisPath, openAnalysisReport } from '@src/components/task-bar/task-utils';

// vi.mock factories are hoisted, so shared state must use vi.hoisted
const { mockDataContext, mockFromMachinePath, mockForFile } = vi.hoisted(() => ({
  mockDataContext: { computeNode: null as any },
  mockFromMachinePath: vi.fn(),
  mockForFile: vi.fn((path: string) => ({ type: 'file', path })),
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  dataContext: mockDataContext,
  VFSPath: { fromMachinePath: mockFromMachinePath },
}));

vi.mock('@src/navigation/DockPointer', () => ({
  DockPointer: { forFile: mockForFile },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockDataContext.computeNode = null;
});

// ---------- getAnalysisPath ----------

describe('getAnalysisPath', () => {
  it('returns null for non-analysis tasks', () => {
    expect(getAnalysisPath({ task_type: 'bug', metadata: { analysisPath: '/p' } } as any)).toBeNull();
  });

  it('returns null when metadata has no analysisPath', () => {
    expect(getAnalysisPath({ task_type: 'analysis', metadata: {} } as any)).toBeNull();
  });

  it('returns null when metadata is undefined', () => {
    expect(getAnalysisPath({ task_type: 'analysis' } as any)).toBeNull();
  });

  it('returns null when analysisPath is not a string', () => {
    expect(getAnalysisPath({ task_type: 'analysis', metadata: { analysisPath: 42 } } as any)).toBeNull();
  });

  it('returns the path for a valid analysis task', () => {
    const task = { task_type: 'analysis', metadata: { analysisPath: '/home/.flow/sessions/abc/analysis.md' } };
    expect(getAnalysisPath(task as any)).toBe('/home/.flow/sessions/abc/analysis.md');
  });
});

// ---------- openAnalysisReport ----------

describe('openAnalysisReport', () => {
  it('opens via VFS path when computeNode is available', () => {
    const fakeTypeId = { toString: () => 'compute_node-@local' };
    mockDataContext.computeNode = { typeId: fakeTypeId };
    mockFromMachinePath.mockReturnValue({ absVfsPath: 'compute_node-@local/home/analysis.md' });

    const navigation = { openDock: vi.fn() } as any;
    openAnalysisReport('/home/analysis.md', navigation);

    expect(mockFromMachinePath).toHaveBeenCalledWith('/home/analysis.md', fakeTypeId);
    expect(navigation.openDock).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw path when computeNode is unavailable', () => {
    mockDataContext.computeNode = null;

    const navigation = { openDock: vi.fn() } as any;
    openAnalysisReport('/fallback/path.md', navigation);

    expect(mockFromMachinePath).not.toHaveBeenCalled();
    expect(navigation.openDock).toHaveBeenCalledTimes(1);
  });
});
