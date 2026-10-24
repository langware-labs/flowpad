/** An entity rename relabels its own tab, never the Assets browser that last showed it. */
import { Tab, TabManager, type TabGateway, type TabRow } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT = '3551b9e7-1575-407d-a079-351b74acefb6';
const DOC = '3f322ee8-ad55-44d4-bbe5-c3cb83d1c44d';

function row(id: string, pointer: string, name: string): TabRow {
  return {
    id,
    pointer,
    target_type: 'markdown',
    target_id: DOC,
    parent_tab_id: null,
    project_id: PROJECT,
    name,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
  };
}

// The rows exactly as the backend stores them.
const assetsRow = row(
  'a0000000-0000-4000-8000-000000000001',
  JSON.stringify({
    viewType: 'assets',
    pointer: '',
    options: { 'scope-mode': 'project', 'scope-activeProjectId': PROJECT },
    tabHash: `assets|project:${PROJECT}`,
    workspaceContent: true,
  }),
  "flow-drops's Assets",
);
const editorRow = row(
  'a0000000-0000-4000-8000-000000000002',
  JSON.stringify({ viewType: 'project', pointer: `${PROJECT}/editor/markdown/typeid/markdown-${DOC}` }),
  'old name',
);

type Handler = (typeId: string, op: string, data: unknown) => void;
const managers: TabManager[] = [];

function setup(rows: TabRow[]) {
  const handlers: Handler[] = [];
  const connection = {
    on: (_event: string, h: Handler) => handlers.push(h),
    off: vi.fn(),
  };
  const setNameById = vi.fn<TabGateway['setNameById']>().mockResolvedValue([]);
  const gateway = {
    listAll: vi.fn().mockResolvedValue(rows.map((r) => new Tab(r))),
    setNameById,
  } as unknown as TabGateway;
  const manager = new TabManager({ gateway, connection: connection as never });
  managers.push(manager);
  manager.adoptGlobal(rows);
  manager.attachContentEntitySync();
  const emit = (name: string) =>
    handlers.forEach((h) => h(`markdown-${DOC}`, 'update', { type: 'markdown', id: DOC, name }));
  return { setNameById, emit };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.resetForTests();
  vi.restoreAllMocks();
});

describe('TabManager content-entity name sync', () => {
  it('does not rename the scope-keyed Assets tab after the doc it showed', async () => {
    const { setNameById, emit } = setup([assetsRow]);
    emit('index');
    await Promise.resolve();
    expect(setNameById).not.toHaveBeenCalled();
  });

  it("renames the doc's own tab, even when the Assets tab comes first", async () => {
    const { setNameById, emit } = setup([assetsRow, editorRow]);
    emit('index');
    await vi.waitFor(() => expect(setNameById).toHaveBeenCalledWith(editorRow.id, 'index'));
    expect(setNameById).toHaveBeenCalledTimes(1);
  });
});
