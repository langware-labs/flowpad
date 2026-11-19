/**
 * Opening a conversation that has no project: the project its tab is filed under
 * (`resolveTabProject`) must be the project the window ends up in after the route
 * loader ran. The strip shows only the window's project, so a mismatch is an open
 * conversation with no tab on screen.
 */
import {
  ContextEntitiesEnum,
  Conversation,
  dataContext,
  dataManager,
  Project,
  resolveTabProject,
  Tab,
  tabManager,
  TypeId,
} from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { loadConversationRoute } from '@src/routes/loaders/load-conversation';
import { afterEach, expect, it, vi } from 'vitest';

const ACTIVE = '55555555-5555-4555-8555-555555555555';
const FILED = '11111111-1111-4111-8111-111111111111';
const CONV = '77e82071-ae2e-4478-b9f0-7bf2e6d96e93';

afterEach(() => vi.restoreAllMocks());

/** Open the conversation from a window in ACTIVE; returns the project the window ends in. */
async function openUnmapped(tabs: Tab[] = []): Promise<{ windowProject: string | null; tabProject: string | null }> {
  const conv = { typeId: new TypeId(Conversation.type, CONV), project_id: null, firstContextOfType: () => null };
  let windowProject: string | null = ACTIVE;
  vi.spyOn(dataManager, 'getByTypeId').mockImplementation((typeId) =>
    Promise.resolve((typeId.type === Conversation.type ? conv : { id: typeId.id }) as never),
  );
  vi.spyOn(tabManager, 'getSnapshot').mockReturnValue(tabs);
  vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue(undefined as never);
  vi.spyOn(dataContext, 'setContextEntityTypeId').mockImplementation(async (key, typeId) => {
    if (key === ContextEntitiesEnum.CurrentProjectTypeId) windowProject = typeId?.id ?? null;
  });
  vi.spyOn(dataContext, 'getContextEntity').mockImplementation((key) =>
    key === ContextEntitiesEnum.CurrentProjectTypeId && windowProject ? ({ id: windowProject } as Project) : null,
  );

  const dock = DockPointer.forConversation(CONV);
  await loadConversationRoute(dock.pointer);
  return { windowProject, tabProject: tabs[0]?.project_id ?? (await resolveTabProject(dock, conv as never)) };
}

it('a conversation with no project: its tab is in the project the window shows', async () => {
  const { windowProject, tabProject } = await openUnmapped();
  expect(tabProject).toBe(windowProject);
});

it('an unmapped conversation whose tab is filed under a project keeps the window there', async () => {
  const filed = new Tab({ pointer: DockPointer.forConversation(CONV).toJSON() ?? '', project_id: FILED });
  const { windowProject } = await openUnmapped([filed]);
  expect(windowProject).toBe(FILED);
});
