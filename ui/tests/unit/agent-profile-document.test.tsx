import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { Agent, FSRef, TypeId, type AssetDocument } from '@sdk';
import { AgentProfileEditor } from '@src/components/assets/editor/agent-profile/AgentProfileEditor';

vi.mock('@src/components/assets/editor/agent-profile/AgentDeploymentsSection', () => ({ AgentDeploymentsSection: () => null }));
vi.mock('@src/components/assets/editor/agent-profile/AgentMcpField', () => ({ AgentMcpField: () => null }));
vi.mock('@src/components/agents/use-agent-launcher', () => ({ useAgentLauncher: () => ({ launch: vi.fn(), busyId: null }) }));
vi.mock('@sdk/react/hooks', async (original) => ({ ...(await original<object>()), useProject: () => ({ project: null }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fixture() {
  const agent = new Agent({ id: '11111111-1111-4111-8111-111111111111', name: 'profile', title: 'Original', enabled: true });
  const mainRef = new FSRef('/selected-copy/agent.md', new TypeId('compute_node', '@local'));
  let stored: AssetDocument = { body_ref: mainRef.toJSON(), raw_text: '', body: 'Original prompt', fields: {name: 'profile', title: 'Original', metadata: {owner: 'team'}}, body_start_line: 7, revision: 'first' };
  vi.spyOn(mainRef, 'readDocument').mockImplementation(() => Promise.resolve(stored));
  const update = vi.spyOn(mainRef, 'updateDocument').mockImplementation((patch) => {
    if (patch.expected_revision !== stored.revision) return Promise.reject(Object.assign(new Error('stale_document'), {status: 409}));
    stored = { ...stored, body: patch.body ?? stored.body, fields: {...stored.fields, ...patch.set_fields}, revision: 'saved' };
    return Promise.resolve(stored);
  });
  const rawWrite = vi.spyOn(mainRef, 'write');
  const entitySave = vi.spyOn(agent, 'save');
  render(<MemoryRouter><AgentProfileEditor agent={agent} mainRef={mainRef} /></MemoryRouter>);
  return { update, rawWrite, entitySave, externalEdit: () => { stored = {...stored, revision: 'external', body: 'External'}; } };
}

describe('Agent profile document adapter', () => {
  it('sends one typed occurrence patch and no raw or entity write', async () => {
    const f = fixture();
    const prompt = await screen.findByRole('textbox', {name: 'System prompt'});
    fireEvent.change(prompt, {target: {value: 'My prompt'}}); fireEvent.blur(prompt);
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(1));
    expect(f.update).toHaveBeenCalledWith({expected_revision: 'first', body: 'My prompt'});
    expect(f.rawWrite).not.toHaveBeenCalled(); expect(f.entitySave).not.toHaveBeenCalled();
  });
  it('keeps a conflicting field draft and does not retry on another blur', async () => {
    const f = fixture(); const title = await screen.findByRole('textbox', {name: 'Agent title'});
    fireEvent.change(title, {target: {value: 'My title'}}); f.externalEdit(); fireEvent.blur(title);
    await screen.findByText('File changed outside this editor. Your edits are preserved.');
    expect(title).toHaveValue('My title');
    fireEvent.blur(title);
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(1));
    expect(f.update).toHaveBeenCalledWith({expected_revision: 'first', set_fields: {title: 'My title'}});
  });
});
