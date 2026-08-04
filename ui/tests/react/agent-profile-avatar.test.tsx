import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent, AGENT_AVATAR_REF, FSRef } from '@sdk';
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

vi.mock('@src/components/assets/editor/agent-profile/AgentDeploymentsSection', () => ({
  AgentDeploymentsSection: () => null,
}));

vi.mock('@src/components/assets/editor/agent-profile/AgentRunDialog', () => ({
  AgentRunDialog: () => null,
}));

const AGENT_ID = 'ebed6648-ad32-4611-a63e-b12bb38b984b';
const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

const AGENT_DOCUMENT = `---
name: Q
title: QA manager
enabled: true
---

Run QA.
`;

function agentMainRef(): FSRef {
  const avatarRef = { getDownloadUrl: mocks.getDownloadUrl };
  const parent = {
    uploadFile: mocks.uploadFile,
    child: vi.fn(() => avatarRef),
  };
  return {
    path: 'agent.md',
    read: mocks.read,
    write: mocks.write,
    parent,
  } as unknown as FSRef;
}

function qAgent(avatar?: string): Agent {
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
  await user.click(screen.getByRole('button', { name: 'Change avatar' }));
  await user.click(await screen.findByRole('tab', { name: 'Image' }));
  fireEvent.change(screen.getByLabelText('Choose avatar image'), { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(AGENT_DOCUMENT);
  mocks.write.mockResolvedValue(undefined);
});

describe('Agent profile avatar', () => {
  it('resolves a canonical bundle image through its asset FSRef and uses the TypeInfo fallback', () => {
    const withImage = qAgent(AGENT_AVATAR_REF);
    const first = render(<AgentProfileEditor agent={withImage} mainRef={agentMainRef()} />);
    const image = screen.getByRole('img', { name: 'Q avatar' });
    expect(image).toHaveAttribute('src', 'http://files.local/avatar.png');
    first.unmount();

    render(<AgentProfileEditor agent={qAgent()} mainRef={agentMainRef()} />);
    expect(screen.getByTestId('registry-agent-icon')).toBeInTheDocument();
  });

  it('keeps Lucide and emoji values while unknown words fall back safely', () => {
    const first = render(<AvatarValue value="Star" alt="star" fallback={<span>fallback</span>} />);
    expect(first.container.querySelector('svg')).toBeInTheDocument();
    first.unmount();

    const second = render(<AvatarValue value="🧪" alt="test tube" fallback={<span>fallback</span>} />);
    expect(screen.getByText('🧪')).toBeInTheDocument();
    second.unmount();

    render(<AvatarValue value="not-an-icon" alt="unknown" fallback={<span>fallback</span>} />);
    expect(screen.getByText('fallback')).toBeInTheDocument();
  });

  it('serializes profile patches through agent.md without calling entity save', async () => {
    let document = AGENT_DOCUMENT;
    mocks.read.mockImplementation(() => Promise.resolve(document));
    mocks.write.mockImplementation((next: string) => {
      document = next;
      return Promise.resolve();
    });
    const agent = qAgent();
    const entitySave = vi.spyOn(agent, 'save');

    render(<AgentProfileEditor agent={agent} mainRef={agentMainRef()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent title' }), {
      target: { value: 'Senior QA manager' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Agent title' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), {
      target: { value: 'Q Prime' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Agent name' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(document).toContain('title: Senior QA manager');
    expect(document).toContain('name: Q Prime');
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
      return Promise.resolve(AGENT_DOCUMENT);
    });
    mocks.write.mockImplementation(() => {
      events.push('write');
      return Promise.resolve();
    });
    const agent = qAgent();

    render(<AgentProfileEditor agent={agent} mainRef={agentMainRef()} />);
    await chooseImage(new File([PNG_1X1], 'portrait.png', { type: 'image/png' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.uploadFile).toHaveBeenCalledWith(expect.any(File));
    expect(uploaded?.name).toBe('avatar.png');
    expect(await readFile(uploaded!)).toEqual(PNG_1X1);
    expect(agent.avatar).toBe('./avatar.png');
    expect(events).toEqual(['upload', 'complete', 'read', 'write']);
  });

  it('preserves the old avatar when upload fails', async () => {
    mocks.uploadFile.mockRejectedValue(new Error('disk unavailable'));
    const agent = qAgent('Star');

    render(<AgentProfileEditor agent={agent} mainRef={agentMainRef()} />);
    await chooseImage(new File([PNG_1X1], 'portrait.png', { type: 'image/png' }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalled());
    expect(agent.avatar).toBe('Star');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('persists avatar removal as an explicit null', async () => {
    const agent = qAgent('Star');
    const user = userEvent.setup();

    render(<AgentProfileEditor agent={agent} mainRef={agentMainRef()} />);
    await user.click(screen.getByRole('button', { name: 'Change avatar' }));
    await user.click(await screen.findByRole('tab', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Remove avatar' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(agent.avatar).toBeNull();
    expect(agent.toJSON()).toMatchObject({ avatar: null });
  });

  it('restores the previous avatar when saving the uploaded reference fails', async () => {
    mocks.uploadFile.mockResolvedValue({ waitForCompletion: () => Promise.resolve() });
    const agent = qAgent('Star');
    mocks.write.mockRejectedValue(new Error('save unavailable'));

    render(<AgentProfileEditor agent={agent} mainRef={agentMainRef()} />);
    await chooseImage(new File([PNG_1X1], 'portrait.png', { type: 'image/png' }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalled());
    expect(agent.avatar).toBe('Star');
  });
});
