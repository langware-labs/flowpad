import { dataManager, GitSetupError, Project } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `Project.setupFromGitOrigin()` — the install of a shared project — surfaces
 * the backend's typed clone failure (U5 / KTD11). `setup-from-git` answers a
 * refused clone with a 400 whose envelope carries `data.code`; the SDK throws a
 * `GitSetupError` holding that code so the install chip can explain WHY (no
 * access to the repo vs. connect GitHub) without parsing git's wording.
 */

const PROJECT_ID = '5b0f7c2e-8a4d-4f7e-9c1a-2d3e4f5a6b7c';

function sharedProject(): Project {
  return new Project({ type: Project.type, id: PROJECT_ID, name: 'Secret course', remote: false } as Partial<Project>);
}

/** What axios rejects with for the action's `ApiFailResponse(status_code=400)`. */
function refused(message: string, data?: Record<string, unknown>) {
  return Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { status: 'FAIL', message, data: data ?? null } },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Project.setupFromGitOrigin failures', () => {
  it('AE6: a repo the invitee cannot access throws GitSetupError with REPO_NOT_ACCESSIBLE', async () => {
    const message = "Git clone failed: remote: Repository not found.\nfatal: repository 'https://github.com/acme/secret.git/' not found";
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(refused(message, { code: 'REPO_NOT_ACCESSIBLE' }));

    const err = await sharedProject().setupFromGitOrigin().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSetupError);
    expect(err).toBeInstanceOf(Error);
    expect((err as GitSetupError).code).toBe('REPO_NOT_ACCESSIBLE');
    // The human sentence is the backend's own, not axios's "status code 400".
    expect((err as GitSetupError).message).toBe(message);
  });

  it('AUTH_REQUIRED rides through as its own code', async () => {
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(
      refused("Git clone failed: fatal: could not read Username for 'https://github.com'", { code: 'AUTH_REQUIRED' }),
    );

    const err = await sharedProject().setupFromGitOrigin().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSetupError);
    expect((err as GitSetupError).code).toBe('AUTH_REQUIRED');
  });

  it('an untyped refusal stays a plain Error with the server message and no code', async () => {
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(refused('Shared project has no Git origin'));

    const err = await sharedProject().setupFromGitOrigin().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitSetupError);
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect((err as Error).message).toBe('Shared project has no Git origin');
  });

  it('a successful install is unchanged: the returned row is adopted', async () => {
    const installed = {
      type: Project.type,
      id: PROJECT_ID,
      name: 'Secret course',
      remote: true,
      fs_storage_mount_path: 'C:/Users/eli/Flowpad workspace/secret',
    };
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(installed);
    const adopted = vi.spyOn(dataManager, 'updateEntityFromJson').mockImplementation(
      (json: Record<string, unknown>) => new Project(json as Partial<Project>) as never,
    );

    const result = await sharedProject().setupFromGitOrigin();

    expect(adopted).toHaveBeenCalledWith(installed);
    expect(result.fs_storage_mount_path).toBe(installed.fs_storage_mount_path);
  });
});
