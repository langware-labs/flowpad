/**
 * A session chip launched as an agent shows that agent's full card on hover —
 * in every view mode — with where it lives and its git origin, both openable.
 * A session with no agent keeps the bare name.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent } from '@sdk';
import { ProcessTabCard } from '@src/tabs/provider-meta';

const openDock = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn());
const launchingAgent = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock } }),
}));
vi.mock('@src/lib/open-external', () => ({ openExternal }));
vi.mock('@src/components/agents/AgentAvatar', () => ({ AgentAvatar: () => <span data-testid="avatar" /> }));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/contexts/view-mode-context')>()),
  useIsAdvanced: () => false,
}));
vi.mock('@src/hooks/use-launching-agent', () => ({ useLaunchingAgent: () => launchingAgent.current }));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({ data: { id: 'p1', deployment_id: 'd1', workdir: '/work/qa-target' } }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProcessTabCard', () => {
  it('shows the agent card with an openable location and git origin', () => {
    launchingAgent.current = new Agent({
      name: 'qa-manager',
      description: 'Runs QA cycles.',
      asset_ref: 'agentic-assets/agent/qa-manager',
      git_origin: { kind: 'git', provider: 'github', owner: 'acme', name: 'qa', branch: 'main', rel_path: 'agents/qa' },
    } as never);
    render(<ProcessTabCard processId="3f2b8c1e-6a4d-4e2b-9c1a-5d7e8f901234" fallbackName="QA manager" />);

    expect(screen.getByTestId('agent-intro-card-description')).toHaveTextContent('Runs QA cycles.');
    expect(screen.getByTestId('tab-workdir')).toHaveTextContent('/work/qa-target');

    fireEvent.click(screen.getByTestId('agent-intro-card-location'));
    expect(openDock).toHaveBeenCalledTimes(1);

    expect(screen.getByTestId('agent-intro-card-git')).toHaveTextContent('acme/qa · main');
    fireEvent.click(screen.getByTestId('agent-intro-card-git'));
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('github.com/acme/qa'));
  });

  it('a session with no agent shows where it is working, without the agent card', () => {
    launchingAgent.current = null;
    render(<ProcessTabCard processId="3f2b8c1e-6a4d-4e2b-9c1a-5d7e8f901234" fallbackName="my session" />);
    expect(screen.getByTestId('tab-session-card')).toBeInTheDocument();
    expect(screen.getByTestId('tab-workdir')).toHaveTextContent('/work/qa-target');
    expect(screen.queryByTestId('tab-agent-card')).not.toBeInTheDocument();
  });
});
