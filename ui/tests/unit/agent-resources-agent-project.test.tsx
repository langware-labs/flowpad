/**
 * The agent's packages are asked under the AGENT's project, never the one that happens to be open.
 * An agent "Make an agent" saved to the personal space has no project: asked under the open project
 * the backend refused it (400 "not an asset of this project") and the panel showed that 400.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, Project, TypeId } from '@sdk';

const AGENT = new TypeId('agent', '11111111-1111-4111-8111-111111111111');
const OPEN = new Project({ id: '22222222-2222-4222-8222-222222222222', name: 'adds' });
const OWN = new Project({ id: '33333333-3333-4333-8333-333333333333', name: 'own' });

const h = vi.hoisted(() => ({ agentProjectId: null as string | null, sectionProject: [] as Array<unknown> }));

vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ activeEntityTypeId: AGENT, project: OPEN }) }));
vi.mock('@sdk/react/hooks', () => ({
  useEntity: (typeId: TypeId | null) => ({
    data: !typeId ? undefined : typeId.type === 'agent' ? new Agent({ id: AGENT.id, name: 'a', project_id: h.agentProjectId }) : typeId.id === OWN.id ? OWN : undefined,
  }),
}));
vi.mock('@src/components/agent-resources/AgentDataSourcesSection', () => ({
  AgentDataSourcesSection: ({ project }: { project: unknown }) => { h.sectionProject.push(project); return null; },
}));
vi.mock('@src/components/agent-resources/useStagedAssets', () => ({ useStagedAssets: () => ({ descriptors: [], isLoading: false, refresh: vi.fn() }) }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntitiesQuery: () => ({ data: [], isLoading: false, refetch: vi.fn() }) }));
vi.mock('@src/components/data-sources/use-source-specs', async (original) => ({ ...(await original<object>()), useSourceSpecs: () => ({ specFor: () => undefined }) }));
vi.mock('@src/components/agent-resources/AgentCredentialsSection', () => ({ AgentCredentialsSection: () => null }));
vi.mock('@src/components/agent-resources/AgentSchedulesSection', () => ({ AgentSchedulesSection: () => null }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }) }));
vi.mock('@src/components/quick-create', () => ({ useQuickCreatePick: () => ({ panelProps: { onPick: vi.fn() }, dialogs: null }) }));

const { AgentResourcesBody } = await import('@src/components/agent-resources/AgentResourcesBody');

afterEach(() => { cleanup(); h.sectionProject = []; });

it('asks no project for an agent that has none, even with another project open', () => {
  h.agentProjectId = null;
  render(<AgentResourcesBody />);
  expect(h.sectionProject.at(-1)).toBeNull();
});

it("asks the agent's own project, not the open one", () => {
  h.agentProjectId = OWN.id;
  render(<AgentResourcesBody />);
  expect(h.sectionProject.at(-1)).toBe(OWN);
});
