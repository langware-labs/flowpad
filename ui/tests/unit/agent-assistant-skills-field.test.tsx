/**
 * The hub page's agent editor crashed with "a.map is not a function" (seen on app.flowpad.ai): the hub has no
 * `assistant_skill_catalog` action, so `GET agent/<id>/assistant_skill_catalog` is parsed there as a plain READ
 * and answers with the agent row. The field must read that as "no catalog", never map over it.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { Agent, dataManager } = await import('@sdk');
const { AgentAssistantSkillsField } =
  await import('@src/components/assets/editor/agent-profile/AgentAssistantSkillsField');

const AGENT_ID = '28b9b566-bfa6-44b1-ad11-e7b033edebca';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const answer = (data: unknown) =>
  vi.spyOn(dataManager, 'callAction').mockImplementation((info) => {
    if (info.fullActionUrl.endsWith('/assistant_skill_catalog')) return Promise.resolve(data);
    return Promise.resolve(null);
  });

describe('AgentAssistantSkillsField', () => {
  it('renders on the hub, where the catalog call answers with the agent row (not a list)', async () => {
    answer({ type: 'agent', id: AGENT_ID, name: 'game-builder' }); // exactly what the hub sends back
    const agent = new Agent({ id: AGENT_ID, name: 'game-builder' });
    expect(await agent.assistantSkillCatalog()).toEqual([]);

    render(<AgentAssistantSkillsField agent={agent} value={null} onCommit={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('agent-assistant-skills')).not.toHaveTextContent('Loading'));
    expect(screen.getByTestId('agent-assistant-skills')).toBeInTheDocument();
  });

  it('lists the skills when the desktop answers with its catalog', async () => {
    answer([{ name: 'web-tester', description: 'Test pages' }]);
    const agent = new Agent({ id: AGENT_ID, name: 'game-builder' });
    render(<AgentAssistantSkillsField agent={agent} value={null} onCommit={() => {}} />);
    expect(await screen.findByText('web-tester')).toBeInTheDocument();
  });
});
