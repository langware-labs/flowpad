import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  project: null as import('@sdk').Project | null,
  agents: [] as import('@sdk').Agent[],
  launch: vi.fn(),
  openDock: vi.fn(),
}));

vi.mock('@sdk/react/hooks', () => ({
  useProject: () => ({ project: h.project }),
}));

vi.mock('@src/hooks/use-project-agents', () => ({
  useProjectAgents: () => ({ agents: h.agents }),
}));

vi.mock('@src/components/agents/use-agent-launcher', () => ({
  useAgentLauncher: () => ({ launch: h.launch, busyId: null }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock } }),
}));

import type { Agent, Project } from '@sdk';
import { ProjectAgentsStrip } from '@src/components/agents/ProjectAgentsStrip';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const EDIT_POINTER = {
  viewType: 'assets',
  pointer: `editor/agent/typeid/agent-${AGENT_ID}`,
} as unknown as Agent['dockPointer'];

function renderStrip() {
  h.project = { id: PROJECT_ID, context_roots: ['/project'] } as Project;
  h.agents = [
    {
      id: AGENT_ID,
      name: 'pirate',
      displayName: 'Pirate',
      enabled: true,
      avatar: null,
      avatarImageUrl: null,
      description: 'Answers like a pirate.',
      dockPointer: EDIT_POINTER,
    } as Agent,
  ];
  return render(<ProjectAgentsStrip projectId={PROJECT_ID} />);
}

afterEach(() => {
  cleanup();
  h.project = null;
  h.agents = [];
  h.launch.mockReset();
  h.openDock.mockReset();
});

describe('ProjectAgentsStrip agent actions', () => {
  it('keeps the main tile as Use and gives Edit its own one-click URL navigation', async () => {
    const user = userEvent.setup();
    renderStrip();
    const agent = h.agents[0];

    await user.click(screen.getByTestId('project-agent-tile'));
    expect(h.launch).toHaveBeenCalledWith(agent, PROJECT_ID);
    expect(h.openDock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('project-agent-edit'));
    expect(h.openDock).toHaveBeenCalledWith(agent.dockPointer);
    expect(h.launch).toHaveBeenCalledTimes(1);
  });

  it('labels the hover-card action Use agent and launches from it', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.hover(screen.getByTestId('project-agent-tile'));
    const use = await screen.findByTestId('agent-intro-card-use');
    expect(use).toHaveTextContent('Use agent');

    await user.click(use);
    expect(h.launch).toHaveBeenCalledWith(h.agents[0], PROJECT_ID);
    expect(h.openDock).not.toHaveBeenCalled();
  });
});
