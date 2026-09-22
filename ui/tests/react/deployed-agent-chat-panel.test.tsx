import '@testing-library/jest-dom/vitest';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent, AgentChat, type AgentChatEvent, Deployment } from '@sdk';
import { DeployedAgentChatPanel } from '@src/components/assets/editor/agent-profile/DeployedAgentChatPanel';

const mocks = vi.hoisted(() => ({
  openDock: vi.fn(),
  openShellProcess: vi.fn(),
}));

vi.mock('@src/components/agents/AgentAvatar', () => ({
  AgentAvatar: () => <div data-testid="deployed-agent-chat-avatar" />,
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: mocks.openDock, openShellProcess: mocks.openShellProcess },
  }),
}));

const agent = new Agent({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Production helper',
  enabled: true,
});
const deployment = new Deployment({
  id: '00000000-0000-4000-8000-000000000002',
  name: 'GCP production box',
  kind: 'runtime.agent',
  parent_type_id: agent.typeId.toString(),
  target: { provider: 'gcp_vm', scope: agent.typeId.toString() },
  status: { sync_state: 'current', provider_state: 'running' },
});

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<DeployedAgentChatPanel agent={agent} deployment={deployment} />, { wrapper });
}

/** A chat whose one turn streams *events*; `send` records what it was asked with. */
function fakeChat(events: AgentChatEvent[]) {
  const send = vi.fn(async function* () {
    for (const event of events) yield event;
  });
  const history = vi.fn().mockResolvedValue([]);
  return { chat: { send, history } as unknown as AgentChat, send, history };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('DeployedAgentChatPanel', () => {
  it('streams a turn through the placement chat endpoint and remembers its conversation', async () => {
    const { chat, send } = fakeChat([
      { type: 'tool', name: 'Read' },
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'there' },
      { type: 'done', conversationId: 'conv-1' },
    ]);
    const forDeployment = vi.spyOn(AgentChat, 'forDeployment').mockResolvedValue(chat);

    renderPanel();

    expect(screen.getByTestId('deployed-agent-chat-title')).toHaveTextContent('Production helper');
    await waitFor(() => expect(screen.getByTestId('deployed-agent-chat-input')).toBeEnabled());
    expect(forDeployment).toHaveBeenCalledWith(deployment);

    await userEvent.type(screen.getByTestId('deployed-agent-chat-input'), 'hi');
    await userEvent.click(screen.getByTestId('deployed-agent-chat-send'));

    await waitFor(() => expect(screen.getByTestId('deployed-agent-chat-assistant')).toHaveTextContent('hello there'));
    expect(screen.getByTestId('deployed-agent-chat-assistant')).toHaveTextContent('Read');
    expect(screen.getByTestId('deployed-agent-chat-user')).toHaveTextContent('hi');
    expect(send).toHaveBeenCalledWith('hi', expect.objectContaining({ conversationId: null }));
    expect(localStorage.getItem(`flowpad.agent-chat.${deployment.id}`)).toBe('conv-1');
  });

  it('says so when the placement has no chat endpoint', async () => {
    vi.spyOn(AgentChat, 'forDeployment').mockResolvedValue(null);

    renderPanel();

    expect(await screen.findByTestId('deployed-agent-chat-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('deployed-agent-chat-input')).toBeDisabled();
  });

  it('opens the agent, and a session on its placement, through navigation', async () => {
    const { chat } = fakeChat([]);
    vi.spyOn(AgentChat, 'forDeployment').mockResolvedValue(chat);
    const useDeployment = vi.spyOn(agent, 'useDeployment').mockResolvedValue({
      process_id: '00000000-0000-4000-8000-000000000003',
      process_typeid: 'agentic_process-00000000-0000-4000-8000-000000000003',
      deployment_id: deployment.id,
    });

    renderPanel();

    await userEvent.click(screen.getByTestId('deployed-agent-chat-agent-link'));
    expect(mocks.openDock).toHaveBeenCalledWith(agent.dockPointer);

    await userEvent.click(screen.getByTestId('deployed-agent-open-session'));
    expect(useDeployment).toHaveBeenCalledWith(deployment.id);
    await waitFor(() => expect(mocks.openShellProcess).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000003'));
  });
});
