import { Project } from '@sdk';
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITask } from '@sdk/entities/task';
import type { IConversation } from '@sdk/entities/conversation';
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
  convA:    '88888888-8888-4888-a888-888888888888',
  convB:    '99999999-9999-4999-a999-999999999999',
  convNew:  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
};

/**
 * Behavioral contract:
 *
 *  1. When a conversation arrives with `remote_project_id` and the mapping
 *     table already has an entry for it, the hook silently auto-applies the
 *     saved local Project (stamps the task subject when present, else the
 *     conversation) without opening the picker dialog.
 *
 *  2. When the user changes the active project in dataContext while an
 *     unmapped subject is in view, the hook persists the mapping and stamps
 *     the subject — regardless of which UI surface picked the project (footer
 *     pill, toolbar Claude button, etc.).
 *
 *  3. The pre-existing footer default project at mount time is NOT auto-
 *     adopted as the mapping; only an actual *change* counts as a pick.
 *
 *  4. While the mapping table is still loading, the dialog stays closed
 *     even if `ensureMapped` is invoked — preventing a needless picker
 *     flash for subjects whose mapping is about to arrive.
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

// useDockNavigation pulls in react-router's `useNavigate`, which throws
// outside a `<Router>`. Stub it — the gate only calls `navigation.openDock`
// from the post-remap navigation path (Feature 1), which we observe via the
// mock instead of asserting on actual navigation.
const openDockMock = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: openDockMock },
    currentDock: null,
  }),
}));

// The gate also calls react-router's `useNavigation()` directly (routerNav —
// in-flight transition state), which throws outside a data router. Stub it to
// the settled state; these tests never exercise an in-flight transition.
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigation: () => ({ state: 'idle' }),
}));

const applyProjectToTaskMock = vi.fn(async (_taskId: string, _project: Project) => ({
  saved: true,
  wasReplacement: false,
}));
const applyProjectToConversationMock = vi.fn(async (_convId: string, _project: Project) => ({
  saved: true,
  wasReplacement: false,
}));
const persistRemoteToLocalMappingMock = vi.fn(
  async (remote: string | null | undefined, local: string | null | undefined) => {
    if (remote && local) setMapping({ mapping: { ...mappingState.mapping, [remote]: local } });
  },
);
vi.mock('@src/components/conversation/apply-project-choice', () => ({
  applyProjectToTask: (...args: any[]) => applyProjectToTaskMock(...(args as [string, Project])),
  applyProjectToConversation: (...args: any[]) =>
    applyProjectToConversationMock(...(args as [string, Project])),
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
project_id: overrides.project_id ?? null,
    ...overrides,
  } as ITask;
}

function makeConv(overrides: Partial<IConversation> = {}): IConversation {
  return {
    id: overrides.id ?? ID.convA,
    type: 'conversation',
remote_project_id: overrides.remote_project_id ?? null,
    remote_project_name: overrides.remote_project_name ?? '',
    project_id: overrides.project_id ?? null,
    ...overrides,
  } as IConversation;
}

function registerFakeProject(id: string, name: string, mountPath: string) {
  fakeProjectsById[id] = { id, name, fs_storage_mount_path: mountPath } as Project;
}

beforeEach(() => {
  setMapping({ mapping: {}, loaded: true });
  setCtxProject(null);
  applyProjectToTaskMock.mockClear();
  applyProjectToConversationMock.mockClear();
  persistRemoteToLocalMappingMock.mockClear();
  openDockMock.mockClear();
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

    const taskA = makeTask({ id: ID.taskA });
    const convA = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    const { result: gateA, rerender: rerenderA } = renderHook(
      ({ task, conv }: { task: ITask; conv: IConversation }) =>
        useProjectMappingGate(task, conv),
      { initialProps: { task: taskA, conv: convA } },
    );

    // Mapping is loaded but empty → no auto-apply, no auto-persist (no project picked yet).
    await waitFor(() => expect(gateA.current.dialogProps.open).toBe(false));
    expect(applyProjectToTaskMock).not.toHaveBeenCalled();
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();

    // User picks a project (simulated by dataContext.project change while subject in view).
    await act(async () => {
      setCtxProject({ id: ID.localY, name: 'Y' });
    });
    rerenderA({ task: taskA, conv: convA });

    await waitFor(() => {
      expect(applyProjectToTaskMock).toHaveBeenCalledWith(ID.taskA, expect.objectContaining({ id: ID.localY }));
      expect(persistRemoteToLocalMappingMock).toHaveBeenCalledWith(ID.remoteX, ID.localY);
    });
    expect(mappingState.mapping[ID.remoteX]).toBe(ID.localY);

    // ── Second task on the same remote project arrives — should auto-apply silently. ──
    applyProjectToTaskMock.mockClear();
    persistRemoteToLocalMappingMock.mockClear();

    const taskB = makeTask({ id: ID.taskB });
    const convB = makeConv({ id: ID.convB, remote_project_id: ID.remoteX });
    const { result: gateB } = renderHook(() => useProjectMappingGate(taskB, convB));

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

    const task = makeTask({ id: ID.taskA });
    const conv = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    const { rerender } = renderHook(
      ({ t, c }: { t: ITask; c: IConversation }) => useProjectMappingGate(t, c),
      { initialProps: { t: task, c: conv } },
    );

    // Sim: footer pill click → ctx.project flips to local-y.
    await act(async () => { setCtxProject({ id: ID.localY }); });
    rerender({ t: task, c: conv });
    await waitFor(() => {
      expect(persistRemoteToLocalMappingMock).toHaveBeenCalledWith(ID.remoteX, ID.localY);
    });

    // Sim: user later switches to a different local project (e.g. via toolbar
    // Claude button → gate dialog → picks Z) — gate sees the change and updates.
    persistRemoteToLocalMappingMock.mockClear();
    applyProjectToTaskMock.mockClear();

    await act(async () => { setCtxProject({ id: ID.localZ }); });
    rerender({ t: task, c: conv });
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

    const newTask = makeTask({ id: ID.taskNew });
    const newConv = makeConv({ id: ID.convNew, remote_project_id: ID.remoteX });
    renderHook(() => useProjectMappingGate(newTask, newConv));

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

    // Footer already had a default project active before the subject ever loaded.
    setCtxProject({ id: ID.localDef });

    const task = makeTask({ id: ID.taskA });
    const conv = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    renderHook(() => useProjectMappingGate(task, conv));

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
    const taskA = makeTask({ id: ID.taskA });
    const convA = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    const { rerender, result: gateA } = renderHook(
      ({ t, c }: { t: ITask; c: IConversation }) => useProjectMappingGate(t, c),
      { initialProps: { t: taskA, c: convA } },
    );

    await act(async () => { setCtxProject({ id: ID.localY }); });
    rerender({ t: taskA, c: convA });
    await waitFor(() => {
      expect(mappingState.mapping[ID.remoteX]).toBe(ID.localY);
    });
    expect(gateA.current.dialogProps.open).toBe(false);

    // Task B — same remote_project_id (on the sibling conv), different task id.
    // Should auto-apply silently using the mapping already in the table.
    applyProjectToTaskMock.mockClear();
    persistRemoteToLocalMappingMock.mockClear();

    const taskB = makeTask({ id: ID.taskB });
    const convB = makeConv({ id: ID.convB, remote_project_id: ID.remoteX });
    const { result: gateB } = renderHook(() => useProjectMappingGate(taskB, convB));

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

    const task = makeTask({ id: ID.taskA });
    const conv = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    const { result } = renderHook(() => useProjectMappingGate(task, conv));

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

    const task = makeTask({ id: ID.taskA });
    const conv = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    const { result } = renderHook(() => useProjectMappingGate(task, conv));

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

// ────────────────────────────────────────────────────────────────────────────
// 6. Task-less conversation (project-scoped chat / hub-direct) — the gate
//    stamps the conversation directly when there is no task subject.
// ────────────────────────────────────────────────────────────────────────────

describe('useProjectMappingGate — task-less conversation subject', () => {
  it('stamps the conversation (not a task) when no task is provided', async () => {
    registerFakeProject(ID.localY, 'Y', '/p/y');

    const conv = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    renderHook(() => useProjectMappingGate(undefined, conv));

    // User picks a project via the footer pill while this task-less conv is in view.
    await act(async () => { setCtxProject({ id: ID.localY }); });

    await waitFor(() => {
      expect(applyProjectToConversationMock).toHaveBeenCalledWith(
        ID.convA,
        expect.objectContaining({ id: ID.localY }),
      );
      expect(persistRemoteToLocalMappingMock).toHaveBeenCalledWith(ID.remoteX, ID.localY);
    });
    // The task path is NOT taken — there's no task subject.
    expect(applyProjectToTaskMock).not.toHaveBeenCalled();
  });

  it('auto-applies the saved mapping by stamping the conversation when no task is present', async () => {
    registerFakeProject(ID.localY, 'Y', '/p/y');
    setMapping({ mapping: { [ID.remoteX]: ID.localY }, loaded: true });

    const conv = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });
    renderHook(() => useProjectMappingGate(undefined, conv));

    await waitFor(() => {
      expect(applyProjectToConversationMock).toHaveBeenCalledWith(
        ID.convA,
        expect.objectContaining({ id: ID.localY }),
      );
    });
    expect(applyProjectToTaskMock).not.toHaveBeenCalled();
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Feature 1 — when the conversation already had a project and the user
//    picks a *different* one, the gate navigates to the new project's home.
// ────────────────────────────────────────────────────────────────────────────

describe('useProjectMappingGate — Feature 1 navigate-on-remap', () => {
  it('navigates only — does NOT rewrite project_id when the conversation already had a different project', async () => {
    registerFakeProject(ID.localZ, 'Z', '/p/z');
    // Conversation arrives already mapped to localY (a prior pick).
    const conv = makeConv({
      id: ID.convA,
      remote_project_id: ID.remoteX,
      project_id: ID.localY,
    });

    renderHook(() => useProjectMappingGate(undefined, conv));

    // User picks a different local project via the footer pill.
    await act(async () => { setCtxProject({ id: ID.localZ }); });

    await waitFor(() => {
      // Feature 1: navigation fires with the picked project's dock pointer.
      expect(openDockMock).toHaveBeenCalledTimes(1);
    });
    // The conversation's project_id is preserved — picking a different
    // project from a mapped conv is a navigation shortcut, not a re-map.
    expect(applyProjectToConversationMock).not.toHaveBeenCalled();
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
  });

  it('does NOT navigate on first-time pick (no previous project to replace) — stamps instead', async () => {
    registerFakeProject(ID.localY, 'Y', '/p/y');
    // Conversation has no project yet.
    const conv = makeConv({ id: ID.convA, remote_project_id: ID.remoteX });

    renderHook(() => useProjectMappingGate(undefined, conv));

    await act(async () => { setCtxProject({ id: ID.localY }); });

    await waitFor(() => {
      expect(applyProjectToConversationMock).toHaveBeenCalled();
    });
    expect(openDockMock).not.toHaveBeenCalled();
  });

  it('navigates on the FIRST switch for a local conv with no remote provenance', async () => {
    // Regression: the conversation has its own project_id but no
    // remote_project_id (a local-origin conv). The auto-persist effect must
    // capture the mount-time activeProjectId on first observation regardless
    // of remote/remap guards — otherwise the user's first project switch
    // would be (mis-)treated as the initial mount and only the *second*
    // switch would navigate.
    registerFakeProject(ID.localZ, 'Z', '/p/z');
    const conv = makeConv({
      id: ID.convA,
      remote_project_id: null,    // local-origin: no remote provenance
      project_id: ID.localY,      // already filed under localY
    });
    // Loader has set ctx.project to match conv.project_id by the time the
    // gate mounts (load-conversation reads conv.project_id).
    setCtxProject({ id: ID.localY });

    renderHook(() => useProjectMappingGate(undefined, conv));

    // First switch (footer pill localY → localZ).
    await act(async () => { setCtxProject({ id: ID.localZ }); });

    await waitFor(() => {
      // Feature 1: navigation must fire on the *first* switch.
      expect(openDockMock).toHaveBeenCalledTimes(1);
    });
    // Conv is preserved.
    expect(applyProjectToConversationMock).not.toHaveBeenCalled();
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
  });

  it('navigates only on task-bound remap — does NOT rewrite the task or conversation', async () => {
    // Regression: the gate must base "is this a remap?" on whichever entity
    // actually carries the existing project. If the conv mirror is null but
    // task.project_id is set, the remap signal must still fire.
    registerFakeProject(ID.localZ, 'Z', '/p/z');
    const task = makeTask({ id: ID.taskA, project_id: ID.localY });
    const conv = makeConv({
      id: ID.convA,
      remote_project_id: ID.remoteX,
      project_id: null, // mirror not set — task carries the existing project
    });
    renderHook(() => useProjectMappingGate(task, conv));

    // Footer pill: user picks a different local project.
    await act(async () => { setCtxProject({ id: ID.localZ }); });

    await waitFor(() => {
      // Feature 1: navigation fires because task already had localY.
      expect(openDockMock).toHaveBeenCalledTimes(1);
    });
    // Task / conversation / mapping table are all left alone.
    expect(applyProjectToTaskMock).not.toHaveBeenCalled();
    expect(applyProjectToConversationMock).not.toHaveBeenCalled();
    expect(persistRemoteToLocalMappingMock).not.toHaveBeenCalled();
  });
});
