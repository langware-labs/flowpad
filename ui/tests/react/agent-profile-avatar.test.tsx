import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent, AGENT_AVATAR_REF, FSRef, type AssetDocument, type DocumentPatch } from '@sdk';
import { AgentProfileEditor } from '@src/components/assets/editor/agent-profile/AgentProfileEditor';
import { AvatarValue } from '@src/lib/avatar-value';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  uploadFile: vi.fn(),
  getDownloadUrl: vi.fn(() => 'http://files.local/avatar.png'),
  notifyError: vi.fn(),
}));

vi.mock('@src/notifications', () => ({
  notify: { error: mocks.notifyError, success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@src/components/graph-view/icons/iconRegistry', async () => {
  const React = await import('react');
  return {
    iconForType: vi.fn(
      () => (props: Record<string, unknown>) =>
        React.createElement('svg', { ...props, 'data-testid': 'registry-agent-icon' }),
    ),
  };
});

vi.mock('@src/components/assets/editor/agent-profile/AgentPlacesColumn', () => ({
  AgentPlacesColumn: () => null,
}));

vi.mock('@src/components/assets/editor/agent-profile/AgentRunDialog', () => ({
  AgentRunDialog: () => null,
}));

vi.mock('@src/components/assets/editor/agent-profile/AgentMcpField', () => ({
  AgentMcpField: () => null,
}));

const AGENT_ID = 'ebed6648-ad32-4611-a63e-b12bb38b984b';
const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

let document: AssetDocument;
function updateDocument(patch: DocumentPatch): Promise<AssetDocument> {
  expect(patch.expected_revision).toBe(document.revision);
  document = { ...document, fields: { ...document.fields, ...patch.set_fields },
    body: patch.body ?? document.body, revision: `${document.revision}-saved` };
  return Promise.resolve(document);
}

function agentMainRef(): FSRef {
  const avatarRef = { getDownloadUrl: mocks.getDownloadUrl };
  const parent = {
    uploadFile: mocks.uploadFile,
    child: vi.fn(() => avatarRef),
  };
  return {
    path: 'agent.md',
    readDocument: mocks.read,
    updateDocument: mocks.write,
    parent,
  } as unknown as FSRef;
}

function qAgent(avatar?: string): Agent {
  document.fields.avatar = avatar ?? null;
  return new Agent({
    id: AGENT_ID,
    name: 'Q',
    title: 'QA manager',
    avatar,
    enabled: true,
    asset_ref: '/workspace/agentic-assets/agent/q/agent.md',
  });
}

function readFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read uploaded avatar'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

async function chooseImage(file: File): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Change avatar' }));
  await user.click(await screen.findByRole('tab', { name: 'Image' }));
  fireEvent.change(screen.getByLabelText('Choose avatar image'), { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  document = { body_ref: { path: '/workspace/agentic-assets/agent/q/agent.md', type_id: 'compute_node-@local', ref_type: 'file', read_only: false },
    raw_text: '', body: 'Run QA.', fields: { name: 'Q', title: 'QA manager', enabled: true },
    body_start_line: 6, revision: 'initial' };
  mocks.read.mockImplementation(() => Promise.resolve(document));
  mocks.write.mockImplementation(updateDocument);
});

describe('Agent profile avatar', () => {
  it('has no agent-wide switch or name box in the header: enabled is per place, the name is the folder', async () => {
    render(<MemoryRouter><AgentProfileEditor agent={qAgent()} mainRef={agentMainRef()} /></MemoryRouter>);

    expect(await screen.findByRole('textbox', { name: 'Agent title' })).toBeInTheDocument();
    expect(screen.queryByText('Agent enabled')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Enable Agent' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Agent name' })).toBeNull();
    expect(screen.getByTestId('agent-name')).toHaveTextContent('Q');
  });

  it('resolves a canonical bundle image through its asset FSRef and uses the TypeInfo fallback', async () => {
    const withImage = qAgent(AGENT_AVATAR_REF);
    const first = render(<MemoryRouter><AgentProfileEditor agent={withImage} mainRef={agentMainRef()} /></MemoryRouter>);
    // Accessible name follows Agent.getDisplayName() — title over name
    // ("assistant turns are signed by the Agent", 378e760f5).
    const image = await screen.findByRole('img', { name: 'QA manager avatar' });
    expect(image).toHaveAttribute('src', 'http://files.local/avatar.png');
    first.unmount();

    render(<MemoryRouter><AgentProfileEditor agent={qAgent()} mainRef={agentMainRef()} /></MemoryRouter>);
    expect(await screen.findByTestId('registry-agent-icon')).toBeInTheDocument();
  });

  it('keeps Lucide and emoji values while unknown words fall back safely', () => {
    const first = render(<AvatarValue value="Star" alt="star" fallback={<span>fallback</span>} />);
    expect(first.container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.queryByText('fallback')).toBeNull();
    first.unmount();

    const second = render(<AvatarValue value="🧪" alt="test tube" fallback={<span>fallback</span>} />);
    expect(screen.getByText('🧪')).toBeInTheDocument();
    second.unmount();

    render(<AvatarValue value="not-an-icon" alt="unknown" fallback={<span>fallback</span>} />);
    expect(screen.getByText('fallback')).toBeInTheDocument();
  });

  it('serializes profile patches through agent.md without calling entity save', async () => {
    const agent = qAgent();
    const entitySave = vi.spyOn(agent, 'save');

    render(<MemoryRouter><AgentProfileEditor agent={agent} mainRef={agentMainRef()} /></MemoryRouter>);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Agent title' }), {
      target: { value: 'Senior QA manager' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Agent title' }));

    await waitFor(() => expect(document.fields).toMatchObject({ title: 'Senior QA manager', name: 'Q' }));
    expect(mocks.write).toHaveBeenCalled();
    expect(entitySave).not.toHaveBeenCalled();
  });

  it('uploads avatar.png beside agent.md before saving the relative reference', async () => {
    const events: string[] = [];
    let uploaded: File | undefined;
    mocks.uploadFile.mockImplementation((file: File) => {
      events.push('upload');
      uploaded = file;
      return Promise.resolve({
        waitForCompletion: () => {
          events.push('complete');
          return Promise.resolve();
        },
      });
    });
    mocks.read.mockImplementation(() => {
      events.push('read');
      return Promise.resolve(document);
    });
    mocks.write.mockImplementation((patch: DocumentPatch) => {
      events.push('write');
      return updateDocument(patch);
    });
    const agent = qAgent();

    render(<MemoryRouter><AgentProfileEditor agent={agent} mainRef={agentMainRef()} /></MemoryRouter>);
    await chooseImage(new File([PNG_1X1], 'portrait.png', { type: 'image/png' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.uploadFile).toHaveBeenCalledWith(expect.any(File));
    expect(uploaded?.name).toBe('avatar.png');
    expect(await readFile(uploaded!)).toEqual(PNG_1X1);
    expect(document.fields.avatar).toBe('./avatar.png');
    expect(events).toEqual(['read', 'upload', 'complete', 'write']);
  });

  it('preserves the old avatar when upload fails', async () => {
    mocks.uploadFile.mockRejectedValue(new Error('disk unavailable'));
    const agent = qAgent('Star');

    render(<MemoryRouter><AgentProfileEditor agent={agent} mainRef={agentMainRef()} /></MemoryRouter>);
    await chooseImage(new File([PNG_1X1], 'portrait.png', { type: 'image/png' }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalled());
    expect(agent.avatar).toBe('Star');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('persists avatar removal as an explicit null', async () => {
    const agent = qAgent('Star');
    const user = userEvent.setup();

    render(<MemoryRouter><AgentProfileEditor agent={agent} mainRef={agentMainRef()} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Change avatar' }));
    await user.click(await screen.findByRole('tab', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Remove avatar' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(document.fields.avatar).toBeNull();
    expect(mocks.write).toHaveBeenCalledWith({expected_revision: 'initial', set_fields: {avatar: null}});
  });

  it('preserves the stored avatar and shows the error when saving the reference fails', async () => {
    mocks.uploadFile.mockResolvedValue({ waitForCompletion: () => Promise.resolve() });
    const agent = qAgent('Star');
    mocks.write.mockRejectedValue(new Error('save unavailable'));

    render(<MemoryRouter><AgentProfileEditor agent={agent} mainRef={agentMainRef()} /></MemoryRouter>);
    await chooseImage(new File([PNG_1X1], 'portrait.png', { type: 'image/png' }));

    await screen.findByText('save unavailable');
    expect(document.fields.avatar).toBe('Star');
    expect(agent.avatar).toBe('Star');
  });
});
