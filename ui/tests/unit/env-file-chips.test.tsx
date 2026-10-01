/**
 * The Credentials header's env files: ONE chip with a count, and a list behind it —
 * each file by name, full path and scope — with the project's declared files
 * added and removed there.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialScopeFile, CredentialsStatus, Project } from '@sdk';

const h = vi.hoisted(() => ({ openMachinePath: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openMachinePath: h.openMachinePath } }),
}));

import { EnvFileChips, envFileLabel, envFileList } from '@src/components/credentials-view/EnvFileChips';

const file = (over: Partial<CredentialScopeFile> & Pick<CredentialScopeFile, 'scope' | 'path'>): CredentialScopeFile => ({
  project_id: over.scope === 'project' ? 'p1' : null,
  environment: 'development',
  exists: true,
  extra_path: null,
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
const BACKEND = file({ scope: 'project', path: '/p/backend/.env', extra_path: 'backend/.env', exists: false });

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('envFileList', () => {
  it('puts the project files first, the home folder last, and keeps a missing declared file removable', () => {
    const list = envFileList(status([HOME, ROOT, BACKEND, file({ scope: 'project', path: '/p/gone', exists: false })]));

    expect(list.map(envFileLabel)).toEqual(['.env.local', 'backend/.env', '~/.env.local']);
  });

  it('names a named environment by its own file', () => {
    expect(envFileLabel(file({ scope: 'project', path: '/p/.env.staging.local', environment: 'staging' }))).toBe(
      '.env.staging.local',
    );
  });
});

describe('EnvFileChips', () => {
  it('is one chip: the first file and a count of the rest', () => {
    render(<EnvFileChips status={status([HOME, ROOT, BACKEND])} project={undefined} onChanged={() => {}} />);

    expect(screen.getAllByTestId('credentials-env-files')).toHaveLength(1);
    expect(screen.getByTestId('credentials-env-files').textContent).toBe('.env.local3');
  });

  it('a lone file with nothing to manage opens on click, no list', async () => {
    render(<EnvFileChips status={status([HOME])} project={undefined} onChanged={() => {}} />);

    expect(screen.queryByTestId('credentials-env-files-count')).toBeNull();
    await userEvent.click(screen.getByTestId('credentials-env-files'));

    expect(h.openMachinePath).toHaveBeenCalledWith('/h/.env.local', expect.anything());
    expect(screen.queryByTestId('credentials-env-files-list')).toBeNull();
  });

  it('lists each file by name, full path and scope, and opens the one clicked', async () => {
    render(<EnvFileChips status={status([HOME, ROOT])} project={undefined} onChanged={() => {}} />);

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
    const onChanged = vi.fn();
    const project = { setEnvFiles } as unknown as Project;
    render(<EnvFileChips status={status([ROOT, BACKEND])} project={project} onChanged={onChanged} />);

    await userEvent.click(screen.getByTestId('credentials-env-files'));
    expect(screen.getByTestId('credentials-env-file-backend/.env').textContent).toContain('Project · added');
    await userEvent.type(screen.getByTestId('credentials-env-file-add-input'), 'web/.env{Enter}');
    expect(setEnvFiles).toHaveBeenLastCalledWith(['backend/.env', 'web/.env']);

    await userEvent.click(screen.getByTestId('credentials-env-file-remove-backend/.env'));
    expect(setEnvFiles).toHaveBeenLastCalledWith([]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('offers no adding for a named environment — it never reads declared files', async () => {
    render(<EnvFileChips status={status([ROOT, HOME], 'staging')} project={{} as Project} onChanged={() => {}} />);

    await userEvent.click(screen.getByTestId('credentials-env-files'));
    expect(screen.queryByTestId('credentials-env-file-add-input')).toBeNull();
  });
});
