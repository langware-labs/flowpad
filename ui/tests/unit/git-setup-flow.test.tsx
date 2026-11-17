/**
 * One git setup flow: the "Git is required" strip opens the wizard, the shared
 * repo picker offers existing / new / "Flowpad git" (details in its tooltip),
 * and "Connect GitHub" is rendered by the picker alone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/git/GitRemoteField', () => ({
  GitRemoteField: ({ testIdPrefix }: { testIdPrefix?: string }) => (
    <button data-testid={`${testIdPrefix}-connect-github`}>Connect</button>
  ),
}));
vi.mock('@src/components/project-home/ProjectCloudLinkButton', () => ({
  ProjectCloudLinkButton: () => <button data-testid="cloud-link">link</button>,
}));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/hooks/use-git-share-preflight', () => ({ invalidateGitPreflight: vi.fn() }));
const launchWizard = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());
vi.mock('@src/notifications', () => ({ notify: { error: notifyError, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  launchWizard,
}));

import type { Project } from '@sdk';
import { GitRepoPicker, type GitTarget } from '@src/components/git/GitRepoPicker';
import { GitRequiredStrip } from '@src/components/git/GitRequiredStrip';

const PROJECT = {
  id: 'p1',
  name: 'demo',
  remote: false,
  fs_storage_mount_path: '/w/demo',
  typeId: { toString: () => 'project.id.p1' },
} as unknown as Project;

afterEach(cleanup);

describe('GitRequiredStrip', () => {
  it('says git is required and "Add git" opens the setup wizard', () => {
    render(<GitRequiredStrip project={PROJECT} />);
    expect(screen.getByTestId('git-required-strip').textContent).toContain('Git is required');
    expect(screen.queryByTestId('git-setup-wizard')).toBeNull();
    fireEvent.click(screen.getByTestId('git-required-add'));
    expect(screen.getByTestId('git-setup-wizard')).toBeTruthy();
    expect(screen.getByTestId('git-setup-mode-flowpad')).toBeTruthy();
  });

  it('has no button without a project (hub cards)', () => {
    render(<GitRequiredStrip />);
    expect(screen.queryByTestId('git-required-add')).toBeNull();
  });

  it('"Flowpad git" sets up through the hub-hosted repo, not the git wizard', () => {
    render(<GitRequiredStrip project={PROJECT} />);
    fireEvent.click(screen.getByTestId('git-required-add'));
    fireEvent.click(screen.getByTestId('git-setup-mode-flowpad'));
    fireEvent.click(screen.getByTestId('git-setup-next'));
    expect(screen.getByTestId('cloud-link')).toBeTruthy();
    expect(launchWizard).not.toHaveBeenCalled();
  });

  it('"Set up" on a project with no folder says so, instead of doing nothing', async () => {
    const noFolder = { ...PROJECT, fs_storage_mount_path: null } as unknown as Project;
    render(<GitRequiredStrip project={noFolder} />);
    fireEvent.click(screen.getByTestId('git-required-add'));
    fireEvent.click(screen.getByTestId('git-setup-mode-new'));
    fireEvent.change(screen.getByTestId('git-setup-name'), { target: { value: 'demo-repo' } });
    fireEvent.click(screen.getByTestId('git-setup-next'));
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Git setup failed', message: 'This project has no folder on this computer.' }),
      ),
    );
    expect(launchWizard).not.toHaveBeenCalled();
    expect(screen.getByTestId('git-setup-mode-new')).toBeTruthy(); // back on the first step
  });
});

describe('GitRepoPicker', () => {
  it('offers existing, new and "Flowpad git" with its details in a tooltip', () => {
    const onChange = vi.fn<(t: GitTarget | null) => void>();
    render(<GitRepoPicker modes={['existing', 'new', 'flowpad']} onChange={onChange} testIdPrefix="p" />);
    expect(screen.getByTestId('p-mode-existing')).toBeTruthy();
    expect(screen.getByTestId('p-mode-new')).toBeTruthy();
    const flowpad = screen.getByTestId('p-mode-flowpad');
    expect(flowpad.textContent).toBe('Flowpad git');
    expect(flowpad.getAttribute('title')).toBe('Hosted by Flowpad — use it when you have no GitHub');
    fireEvent.click(flowpad);
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'flowpad' });
  });

  it('renders Connect GitHub on the existing-repo path', () => {
    render(<GitRepoPicker onChange={() => {}} testIdPrefix="p" />);
    expect(screen.getByTestId('p-connect-github')).toBeTruthy();
  });
});

describe('Connect GitHub lives only in the repo picker', () => {
  const SRC = resolve(__dirname, '../../src');
  it.each([
    'components/project-selector/NewProjectFromGitDialog.tsx',
    'components/helpdesk/AddHelpdeskDialog.tsx',
    'components/git/GitTargetDialog.tsx',
    'components/git/GitSetupWizard.tsx',
    'components/git/GitRequiredStrip.tsx',
    'components/project-home/ProjectGitChecksDialog.tsx',
    'hooks/use-add-dependency.tsx',
    'pages/hub-home/NewSandboxDialog.tsx',
    'pages/entry/OpenSandboxLanding.tsx',
    'pages/entry/InstallLanding.tsx',
    'components/share-to-conversation/ShareToConversationDialog.tsx',
  ])('%s does not start the GitHub connection itself', (file) => {
    const text = readFileSync(resolve(SRC, file), 'utf8');
    expect(text).not.toMatch(/oauthService\.connect/);
  });
});
