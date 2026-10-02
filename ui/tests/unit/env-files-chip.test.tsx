/**
 * The Credentials header's env files: ONE chip with a count, and a list behind it —
 * each file by name, full path and scope — with the project's declared files
 * added and removed there.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialScopeFile, CredentialsStatus, Project } from '@sdk';

const h = vi.hoisted(() => ({ openMachinePath: vi.fn(), refresh: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openMachinePath: h.openMachinePath } }),
}));
vi.mock('@src/components/credentials/use-credentials', () => ({ useRefreshCredentials: () => h.refresh }));

import { EnvFilesChip, envFileLabel, envFileList } from '@src/components/credentials-view/EnvFilesChip';
import { envFilesOf } from '@src/components/credentials-view/credential-rows';

const file = (over: Partial<CredentialScopeFile> & Pick<CredentialScopeFile, 'scope' | 'path'>): CredentialScopeFile => ({
  project_id: over.scope === 'project' ? 'p1' : null,
  environment: 'development',
  exists: true,
  blocked: false,
  block_code: null,
  block_reason: null,
  detected: [],
  ...over,
});

const status = (files: CredentialScopeFile[], environment = 'development'): CredentialsStatus =>
  ({ project_id: 'p1', environment, vault_enabled: true, credentials: [], files }) as unknown as CredentialsStatus;

const HOME = file({ scope: 'user', path: '/h/.env.local' });
const ROOT = file({ scope: 'project', path: '/p/.env.local' });
const BACKEND = { path: '/p/backend/.env', extra_path: 'backend/.env', exists: false, detected: [] };
const ROOT_WITH_BACKEND = { ...ROOT, fallbacks: [BACKEND] };

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('envFileList', () => {
  it('puts the project files first, the home folder last, and keeps a missing declared file removable', () => {
    const list = envFileList(status([HOME, ROOT_WITH_BACKEND]));

    expect(list.map(envFileLabel)).toEqual(['.env.local', 'backend/.env', '~/.env.local']);
  });

  it('leaves out a scope file that does not exist', () => {
    expect(envFileList(status([file({ scope: 'project', path: '/p/.env.local', exists: false })]))).toEqual([]);
  });

  it('names a named environment by its own file', () => {
    const [entry] = envFilesOf(file({ scope: 'project', path: '/p/.env.staging.local', environment: 'staging' }));
    expect(envFileLabel(entry)).toBe('.env.staging.local');
  });
});

describe('EnvFileChips', () => {
  it('is one chip: the first file and a count of the rest', () => {
    render(<EnvFilesChip status={status([HOME, ROOT_WITH_BACKEND])} project={undefined} />);

    expect(screen.getAllByTestId('credentials-env-files')).toHaveLength(1);
    expect(screen.getByTestId('credentials-env-files').textContent).toBe('.env.local3');
  });

  it('a lone file with nothing to manage opens on click, no list', async () => {
    render(<EnvFilesChip status={status([HOME])} project={undefined} />);

    expect(screen.queryByTestId('credentials-env-files-count')).toBeNull();
    await userEvent.click(screen.getByTestId('credentials-env-files'));

    expect(h.openMachinePath).toHaveBeenCalledWith('/h/.env.local', expect.anything());
    expect(screen.queryByTestId('credentials-env-files-list')).toBeNull();
  });

  it('lists each file by name, full path and scope, and opens the one clicked', async () => {
    render(<EnvFilesChip status={status([HOME, ROOT])} project={undefined} />);

    await userEvent.click(screen.getByTestId('credentials-env-files'));
    const user = screen.getByTestId('credentials-env-file-user');
    expect(user.textContent).toContain('~/.env.local');
    expect(user.textContent).toContain('/h/.env.local');
    expect(user.textContent).toContain('User');
    expect(screen.getByTestId('credentials-env-file-project').textContent).toContain('Project');

    await userEvent.click(user);
    expect(h.openMachinePath).toHaveBeenCalledWith('/h/.env.local', expect.anything());
  });

  it('adds and removes a project-declared file through the project', async () => {
    const setEnvFiles = vi.fn().mockResolvedValue({ env_files: [] });
    const project = { setEnvFiles } as unknown as Project;
    render(<EnvFilesChip status={status([ROOT_WITH_BACKEND])} project={project} />);

    await userEvent.click(screen.getByTestId('credentials-env-files'));
    expect(screen.getByTestId('credentials-env-file-backend/.env').textContent).toContain('Project · added');
    await userEvent.type(screen.getByTestId('credentials-env-file-add-input'), 'web/.env{Enter}');
    expect(setEnvFiles).toHaveBeenLastCalledWith(['backend/.env', 'web/.env']);

    await userEvent.click(screen.getByTestId('credentials-env-file-remove-backend/.env'));
    expect(setEnvFiles).toHaveBeenLastCalledWith([]);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('offers no adding for a named environment — it never reads declared files', async () => {
    render(<EnvFilesChip status={status([ROOT, HOME], 'staging')} project={{} as Project} />);

    await userEvent.click(screen.getByTestId('credentials-env-files'));
    expect(screen.queryByTestId('credentials-env-file-add-input')).toBeNull();
  });
});
