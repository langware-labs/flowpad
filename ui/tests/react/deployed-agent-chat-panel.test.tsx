import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent, AgenticProcess, Deployment, ProcessKind } from '@sdk';
import { DeployedAgentChatPanel } from '@src/components/assets/editor/agent-profile/DeployedAgentChatPanel';

const mocks = vi.hoisted(() => ({
  executionProps: null as Record<string, unknown> | null,
  openDock: vi.fn(),
}));

vi.mock('@src/components/agents/AgentAvatar', () => ({
  AgentAvatar: () => <div data-testid="deployed-agent-chat-avatar" />,
}));

vi.mock('@src/components/entity-execution-panel', () => ({
  EntityExecutionPanel: (props: Record<string, unknown>) => {
    mocks.executionProps = props;
    return <div data-testid="generic-execution-panel" />;
  },
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: mocks.openDock } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executionProps = null;
});

describe('DeployedAgentChatPanel', () => {
  it('reuses the generic chat panel while binding creation and history to one deployment', async () => {
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
    const remoteProcess = new AgenticProcess({
      id: '00000000-0000-4000-8000-000000000003',
      target_typeid_str: agent.typeId.toString(),
      process_type: ProcessKind.Chat,
      deployment_id: deployment.id,
    });
    const useDeployment = vi.spyOn(agent, 'useDeployment').mockResolvedValue({
      process_id: remoteProcess.id,
      process_typeid: remoteProcess.typeId.toString(),
      deployment_id: deployment.id,
    });
    const getById = vi.spyOn(AgenticProcess, 'getById').mockResolvedValue(remoteProcess);

    render(<DeployedAgentChatPanel agent={agent} deployment={deployment} />);

    expect(screen.getByTestId('deployed-agent-chat-title')).toHaveTextContent('Production helper');
    expect(screen.getByTestId('generic-execution-panel')).toBeInTheDocument();
    expect(mocks.executionProps).toMatchObject({
      target: agent.typeId.toString(),
      processType: ProcessKind.Chat,
      deploymentId: deployment.id,
      dense: true,
      showAssetManager: false,
      showProjectSetting: false,
      allowAttachments: false,
      allowImagePaste: false,
    });

    const createProcess = mocks.executionProps?.createProcess as () => Promise<AgenticProcess>;
    await expect(createProcess()).resolves.toBe(remoteProcess);
    expect(useDeployment).toHaveBeenCalledWith(deployment.id);
    expect(getById).toHaveBeenCalledWith(remoteProcess.id);

    await userEvent.click(screen.getByTestId('deployed-agent-chat-agent-link'));
    expect(mocks.openDock).toHaveBeenCalledWith(agent.dockPointer);
  });
});
