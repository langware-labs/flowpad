import {
  ComputeNode,
  ComputeProviderType,
  ContextEntitiesEnum,
  dataContext,
  Flow,
  Membership,
  Page,
  Project,
  TypeId,
  User,
  Workspace,
} from '@sdk';
import { AgenticProcessMock as FlowMock } from '../utils/stub/agentic_process_mock';
// @shoelace-style/shoelace is not available in this project
// import { SlAlert } from '@shoelace-style/shoelace';
import { v4 as uuidv4 } from 'uuid';
import { vi } from 'vitest';
import { installLeakTripwire } from '../_cleanup';

// Leak tripwire only: the unit tier is fully mocked (no live POSTs), so this is
// a cheap regression guard for a future unit test that starts creating real
// backend entities. No-ops silently when no backend is reachable.
installLeakTripwire(['skill']);

export const currentUser = new User({
  id: uuidv4(),
  created_by: uuidv4(),
  email: 'test@123.com',
  name: 'Test User',
});

export const currentWorkspace = new Workspace({
  id: uuidv4(),
  created_by: uuidv4(),
  name: 'Test Workspace',
  namespace: 'test-workspace',
});
currentWorkspace.addToAllowedActions('members');

export const mockMembers: Membership[] = [
  { user_id: '1', user_email: 'test1@example.com', role: 'admin', user_name: 'User 1' },
  { user_id: '2', user_email: 'test2@example.com', role: 'user,owner', user_name: 'User 2' },
  {
    user_id: currentUser.id,
    user_email: currentUser.email!,
    role: 'owner',
    user_name: currentUser.name,
  },
];

const mockSharedFlows: Flow[] = [];
for (let i = 0; i < 3; i++) {
  const flow = createFlow(`shared flow ${i}`);
  flow.addToAllowedActions('members');
  mockSharedFlows.push(flow);
}

const mockPrivateFlows: Flow[] = [createFlow('private flow')];

export const mockFlow = mockSharedFlows[0];

function createFlow(title: string) {
  return new Flow({ id: uuidv4(), title: title, created_by: uuidv4() });
}

export const mockPages: Page[] = [];
for (let i = 0; i < 4; i++) {
  const is_private = i === 0;
  const title = is_private ? 'private page' : 'shared page';
  const id = uuidv4();
  const pageTypeId = new TypeId(Page.type, id);
  const page = new Page({
    id: id,
    created_by: uuidv4(),
    title: `${title} ${i}`,
    is_private,
  });
  page.expand = page.expand ?? { auth_scopes: [] };

  if (page.expand.auth_scopes) {
    page.expand.auth_scopes.push([pageTypeId.toString()]);
  } else {
    page.expand.auth_scopes = [[pageTypeId.toString()]];
  }
  mockPages.push(page);
}

const typeIdsOfSharedEntities = [
  ...mockSharedFlows.map((flow) => flow.typeId),
  ...mockPages.filter((page) => !page.is_private).map((page) => page.typeId),
];
const typeIdsOfPrivateEntities = [
  ...mockPrivateFlows.map((flow) => flow.typeId),
  ...mockPages.filter((page) => page.is_private).map((page) => page.typeId),
];

export async function mockRefreshProject() {
  return Promise.resolve();
}

export async function mockCallAction(actionInfo: { name: string; targetEntity?: TypeId; method: string }) {
  if (actionInfo.name === 'get-compute-node' && actionInfo.method === 'get') {
    return {
      compute_node: new ComputeNode({
        id: uuidv4(),
        created_by: uuidv4(),
        name: 'Test Compute Node',
        runtime: { name: 'test' },
        node_provider_type: ComputeProviderType.LOCAL_MACHINE,
        node_config: { launch: true },
      }).markAsExpanded(),
    };
  }
  if (actionInfo.method.toLowerCase() !== 'get' || actionInfo.name !== 'members' || !actionInfo.targetEntity) {
    return;
  }
  const { targetEntity } = actionInfo;
  if (typeIdsOfSharedEntities.some((value) => value.equals(targetEntity))) {
    return mockMembers;
  }
  if (typeIdsOfPrivateEntities.some((value) => value.equals(targetEntity))) {
    return [mockMembers[0]];
  }
  return [];
}

// Shoelace is not available in this project
// Object.defineProperty(SlAlert.prototype, 'handleOpenChange', {
//   value: vi.fn(),
// });

// Object.defineProperty(SlSelect.prototype, 'handleOpenChange', {
//   value: vi.fn(),
// });

// Mock the ResizeObserver
const ResizeObserverMock = vi.fn(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));
if (!window.ResizeObserver) {
  window.ResizeObserver = ResizeObserverMock;
}

// Stub the global ResizeObserver
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

export async function createMockFolwInContext(): Promise<FlowMock> {
  const flow = new FlowMock({ title: 'Test Flow' });
  const projectTypeId = flow.projectTypeId;
  const project = new Project({ id: projectTypeId?.id, name: 'Test Project' });
  project.markAsExpanded();
  const computeNode = new ComputeNode({
    id: uuidv4(),
    created_by: uuidv4(),
    name: 'Test Compute Node',
    runtime: { name: 'test' },
    node_provider_type: ComputeProviderType.LOCAL_MACHINE,
    node_config: { launch: true },
  });
  computeNode.markAsExpanded();
  computeNode._isLoaded = true;
  project.computeNode = computeNode;
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
  return flow;
}
