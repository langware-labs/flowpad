import { Project } from '@sdk';
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITask } from '@sdk/entities/task';
import { useProjectMappingGate } from '@src/components/conversation/useProjectMappingGate';

// Stable uuidv4-shaped ids so TypeId validation accepts them.
const ID = {
  taskA:    '11111111-1111-4111-a111-111111111111',
  taskB:    '22222222-2222-4222-a222-222222222222',
  taskNew:  '33333333-3333-4333-a333-333333333333',
  remoteX:  '44444444-4444-4444-a444-444444444444',
  localY:   '55555555-5555-4555-a555-555555555555',
  localZ:   '66666666-6666-4666-a666-666666666666',
  localDef: '77777777-7777-4777-a777-777777777777',
};

/**
 * Behavioral contract:
 *
 *  1. When a task arrives with `remote_project_id` and the mapping table
 *     already has an entry for it, the hook silently auto-applies the saved
 *     local Project (stamps the task) without opening the picker dialog.
 *
 *  2. When the user changes the active project in dataContext while an
 *     unmapped task is in view, the hook persists the mapping and stamps
 *     the task — regardless of which UI surface picked the project (footer
 *     pill, toolbar Claude button, etc.).
 *
 *  3. The pre-existing footer default project at mount time is NOT auto-
 *     adopted as the mapping; only an actual *change* counts as a pick.
 *
 *  4. While the mapping table is still loading, the dialog stays closed
 *     even if `ensureMapped` is invoked — preventing a needless picker
 *     flash for tasks whose mapping is about to arrive.
 */

// ────────────────────────────────────────────────────────────────────────────
// Mock module wiring — control mapping/context/persistence from the test.
// ────────────────────────────────────────────────────────────────────────────

type MappingState = { mapping: Record<string, string>; loaded: boolean };
const mappingState: MappingState = { mapping: {}, loaded: true };
const mappingListeners = new Set<() => void>();
function setMapping(next: Partial<MappingState>) {
  if (next.mapping !== undefined) mappingState.mapping = next.mapping;
  if (next.loaded !== undefined) mappingState.loaded = next.loaded;
  mappingListeners.forEach((cb) => cb());
}

vi.mock('@src/components/conversation/useProjectMapping', () => ({
  useProjectMapping: () => {
    const [, force] = (globalThis as any).React.useReducer((x: number) => x + 1, 0);
    (globalThis as any).React.useEffect(() => {
      mappingListeners.add(force);
      return () => { mappingListeners.delete(force); };
    }, [force]);
    return { mapping: mappingState.mapping, loaded: mappingState.loaded, setMapping: vi.fn() };
  },
  writeProjectMapping: vi.fn(async (remote: string, local: string) => {
    setMapping({ mapping: { ...mappingState.mapping, [remote]: local } });
    return mappingState.mapping;
  }),
}));

type CtxState = { project: { id: string; name?: string } | null };
const ctxState: CtxState = { project: null };
const ctxListeners = new Set<() => void>();
function setCtxProject(project: CtxState['project']) {
  ctxState.project = project;
  ctxListeners.forEach((cb) => cb());
}

vi.mock('@src/hooks/useContext', () => ({
  useContext: () => {
    const [, force] = (globalThis as any).React.useReducer((x: number) => x + 1, 0);
    (globalThis as any).React.useEffect(() => {
      ctxListeners.add(force);
      return () => { ctxListeners.delete(force); };
    }, [force]);
    return { project: ctxState.project };
  },
}));

const applyProjectToTaskMock = vi.fn(async (_taskId: string, _project: Project) => true);
const persistRemoteToLocalMappingMock = vi.fn(
  async (remote: string | null | undefined, local: string | null | undefined) => {
    if (remote && local) setMapping({ mapping: { ...mappingState.mapping, [remote]: local } });
  },
);
vi.mock('@src/components/conversation/apply-project-choice', () => ({
  applyProjectToTask: (...args: any[]) => applyProjectToTaskMock(...(args as [string, Project])),
  persistRemoteToLocalMapping: (...args: any[]) =>
    persistRemoteToLocalMappingMock(...(args as [string | null | undefined, string | null | undefined])),
}));

// dataManager.getByTypeId returns a fake Project keyed off the requested id.
const fakeProjectsById: Record<string, Partial<Project>> = {};
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    dataManager: {
      ...actual.dataManager,
      getByTypeId: vi.fn(async (typeId: { id: string }) => {
        return fakeProjectsById[typeId.id] ?? null;
      }),
    },
  };
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ITask> = {}): ITask {
  return {
    id: overrides.id ?? ID.taskA,
    type: 'task',
    metadata: overrides.metadata ?? {},
    remote_project_id: overrides.remote_project_id ?? null,
    remote_project_name: overrides.remote_project_name ?? '',
    project_id: overrides.project_id ?? null,
    ...overrides,
  } as ITask;
}

function registerFakeProject(id: string, name: string, mountPath: string) {
  fakeProjectsById[id] = { id, name, fs_storage_mount_path: mountPath } as Project;
}

beforeEach(() => {
  setMapping({ mapping: {}, loaded: true });
  setCtxProject(null);
  applyProjectToTaskMock.mockClear();
  persistRemoteToLocalMappingMock.mockClear();
  for (const k of Object.keys(fakeProjectsById)) delete fakeProjectsById[k];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Empty mapping → user picks → mapping persists → second task auto-applies.
// ────────────────────────────────────────────────────────────────────────────

describe('useProjectMappingGate — full mapping lifecycle', () => {
  it('persists mapping when user picks for the first task and silently re-applies for the second', async () => {
    registerFakeProject(ID.localY, 'Y', '/Users/me/projects/y');

    const taskA = makeTask({ id: ID.taskA, remote_project_id: ID.remoteX });
    const { result: gateA, rerender: rerenderA } = renderHook(
      ({ task }: { task: ITask }) => useProjectMappingGate(task),
      { initialProps: { task: taskA } },
    );

    // Mapping is loaded but empty → no auto-apply, no auto-persist (no project picked yet).
    await waitFor(() => expect(gateA.current.dialogProps.open).toBe(false));
    expect(applyProjectToTaskMock).not.toHaveBeenCalled();
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();

    // User picks a project (simulated by dataContext.project change while task in view).
    await act(async () => {
      setCtxProject({ id: ID.localY, name: 'Y' });
    });
    rerenderA({ task: taskA });

    await waitFor(() => {
      expect(applyProjectToTaskMock).toHaveBeenCalledWith(ID.taskA, expect.objectContaining({ id: ID.localY }));
      expect(persistRemoteToLocalMappingMock).toHaveBeenCalledWith(ID.remoteX, ID.localY);
    });
    expect(mappingState.mapping[ID.remoteX]).toBe(ID.localY);

    // ── Second task on the same remote project arrives — should auto-apply silently. ──
    applyProjectToTaskMock.mockClear();
    persistRemoteToLocalMappingMock.mockClear();

    const taskB = makeTask({ id: ID.taskB, remote_project_id: ID.remoteX });
    const { result: gateB } = renderHook(() => useProjectMappingGate(taskB));

    await waitFor(() => {
      expect(applyProjectToTaskMock).toHaveBeenCalledWith(ID.taskB, expect.objectContaining({ id: ID.localY }));
    });
    // Auto-apply doesn't re-persist (mapping already there).
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
    // Dialog never opened.
    expect(gateB.current.dialogProps.open).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Project change is detected regardless of which UI changed it.
// ────────────────────────────────────────────────────────────────────────────

describe('useProjectMappingGate — project-change detection', () => {
  it('persists mapping when active project changes via any picker (footer pill or toolbar)', async () => {
    registerFakeProject(ID.localY, 'Y', '/p/y');
    registerFakeProject(ID.localZ, 'Z', '/p/z');

    const task = makeTask({ id: ID.taskA, remote_project_id: ID.remoteX });
    const { rerender } = renderHook(
      ({ t }: { t: ITask }) => useProjectMappingGate(t),
      { initialProps: { t: task } },
    );

    // Sim: footer pill click → ctx.project flips to local-y.
    await act(async () => { setCtxProject({ id: ID.localY }); });
    rerender({ t: task });
    await waitFor(() => {
      expect(persistRemoteToLocalMappingMock).toHaveBeenCalledWith(ID.remoteX, ID.localY);
    });

    // Sim: user later switches to a different local project (e.g. via toolbar
    // Claude button → gate dialog → picks Z) — gate sees the change and updates.
    persistRemoteToLocalMappingMock.mockClear();
    applyProjectToTaskMock.mockClear();

    await act(async () => { setCtxProject({ id: ID.localZ }); });
    rerender({ t: task });
    await waitFor(() => {
      expect(persistRemoteToLocalMappingMock).toHaveBeenCalledWith(ID.remoteX, ID.localZ);
      expect(applyProjectToTaskMock).toHaveBeenCalledWith(ID.taskA, expect.objectContaining({ id: ID.localZ }));
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Mapping exists, ctx project diverges from mapping, new msg arrives —
//    mapping wins; the auto-apply uses the SAVED local id, not ctx.project.
// ────────────────────────────────────────────────────────────────────────────

describe('useProjectMappingGate — mapping wins over divergent context', () => {
  it('auto-applies the saved local project for a fresh task even when ctx.project is something else', async () => {
    registerFakeProject(ID.localY, 'Y', '/p/y');
    registerFakeProject(ID.localZ, 'Z', '/p/z');

    // Mapping already present (from a prior pick).
    setMapping({ mapping: { [ID.remoteX]: ID.localY }, loaded: true });
    // User has since switched the global active project to something unrelated.
    setCtxProject({ id: ID.localZ });

    const newTask = makeTask({ id: ID.taskNew, remote_project_id: ID.remoteX });
    renderHook(() => useProjectMappingGate(newTask));

    await waitFor(() => {
      expect(applyProjectToTaskMock).toHaveBeenCalledWith(
        ID.taskNew,
        expect.objectContaining({ id: ID.localY }),
      );
    });
    // Mapping wasn't rewritten — the auto-apply path doesn't re-persist.
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
    // Critically, the unrelated ctx.project (local-z) was NOT adopted.
    const stamped = applyProjectToTaskMock.mock.calls[0]?.[1] as Project;
    expect(stamped.id).toBe(ID.localY);
    expect(stamped.id).not.toBe(ID.localZ);
  });

  it('does not auto-adopt the pre-existing ctx.project as a mapping at mount', async () => {
    registerFakeProject(ID.localDef, 'Default', '/p/default');

    // Footer already had a default project active before the task ever loaded.
    setCtxProject({ id: ID.localDef });

    const task = makeTask({ id: ID.taskA, remote_project_id: ID.remoteX });
    renderHook(() => useProjectMappingGate(task));

    // Give a few ticks for any spurious effect to fire.
    await new Promise((r) => setTimeout(r, 50));

    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
    expect(applyProjectToTaskMock).not.toHaveBeenCalled();
    expect(mappingState.mapping[ID.remoteX]).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Two tasks on the same remote project — the second one auto-maps without
//    showing the picker.
// ────────────────────────────────────────────────────────────────────────────

describe('useProjectMappingGate — sibling tasks reuse mapping', () => {
  it('auto-maps a sibling task to the same local project without opening the dialog', async () => {
    registerFakeProject(ID.localY, 'Y', '/p/y');

    // Task A — first time: empty mapping, user picks, mapping is persisted.
    const taskA = makeTask({ id: ID.taskA, remote_project_id: ID.remoteX });
    const { rerender, result: gateA } = renderHook(
      ({ t }: { t: ITask }) => useProjectMappingGate(t),
      { initialProps: { t: taskA } },
    );

    await act(async () => { setCtxProject({ id: ID.localY }); });
    rerender({ t: taskA });
    await waitFor(() => {
      expect(mappingState.mapping[ID.remoteX]).toBe(ID.localY);
    });
    expect(gateA.current.dialogProps.open).toBe(false);

    // Task B — same remote_project_id, different task id. Should auto-apply
    // silently using the mapping already in the table.
    applyProjectToTaskMock.mockClear();
    persistRemoteToLocalMappingMock.mockClear();

    const taskB = makeTask({ id: ID.taskB, remote_project_id: ID.remoteX });
    const { result: gateB } = renderHook(() => useProjectMappingGate(taskB));

    await waitFor(() => {
      expect(applyProjectToTaskMock).toHaveBeenCalledWith(ID.taskB, expect.objectContaining({ id: ID.localY }));
    });
    expect(gateB.current.dialogProps.open).toBe(false);
    // No re-write of an already-correct mapping.
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. While mapping is still loading, ensureMapped does NOT pop the dialog —
//    once loaded, if a mapping exists it auto-applies; if not, the dialog
//    opens against the queued continuation.
// ────────────────────────────────────────────────────────────────────────────

describe('useProjectMappingGate — picker stays closed during loading window', () => {
  it('defers opening the dialog until the mapping table has finished loading', async () => {
    setMapping({ mapping: {}, loaded: false });
    registerFakeProject(ID.localY, 'Y', '/p/y');

    const task = makeTask({ id: ID.taskA, remote_project_id: ID.remoteX });
    const { result } = renderHook(() => useProjectMappingGate(task));

    // User clicks an action chip during the loading window.
    const cont = vi.fn();
    act(() => { result.current.ensureMapped(cont); });
    expect(result.current.dialogProps.open).toBe(false);
    expect(cont).not.toHaveBeenCalled();

    // Mapping resolves with an entry → auto-apply silently runs the continuation.
    await act(async () => {
      setMapping({ mapping: { [ID.remoteX]: ID.localY }, loaded: true });
    });

    await waitFor(() => {
      expect(applyProjectToTaskMock).toHaveBeenCalledWith(ID.taskA, expect.objectContaining({ id: ID.localY }));
      expect(cont).toHaveBeenCalledTimes(1);
    });
    // Dialog never opened.
    expect(result.current.dialogProps.open).toBe(false);
  });

  it('opens the dialog only after the mapping table loads with no entry', async () => {
    setMapping({ mapping: {}, loaded: false });

    const task = makeTask({ id: ID.taskA, remote_project_id: ID.remoteX });
    const { result } = renderHook(() => useProjectMappingGate(task));

    const cont = vi.fn();
    act(() => { result.current.ensureMapped(cont); });
    expect(result.current.dialogProps.open).toBe(false);

    // Mapping loaded, still empty → dialog now opens for the queued continuation.
    await act(async () => {
      setMapping({ mapping: {}, loaded: true });
    });
    await waitFor(() => expect(result.current.dialogProps.open).toBe(true));
    expect(cont).not.toHaveBeenCalled();
  });
});
