import { Project, QueryRequest, dataManager } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4, v5 as uuidv5, validate as uuidValidate, version as uuidVersion } from 'uuid';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import fs from 'node:fs';
import path from 'node:path';

const UUID_NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function canonicalPosixPath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  const toPosix = (p: string) => p.replace(/\\/g, '/');

  if (fs.existsSync(resolved)) {
    return toPosix(fs.realpathSync.native(resolved));
  }

  const parent = path.dirname(resolved);
  const basename = path.basename(resolved);
  try {
    return path.posix.join(toPosix(fs.realpathSync.native(parent)), basename);
  } catch {
    return toPosix(resolved);
  }
}

function legacyProjectPathAlias(mountPath: string): string {
  return uuidv5(`project:${canonicalPosixPath(mountPath)}`, UUID_NAMESPACE_DNS);
}

function expectOpaqueProjectId(id: string, mountPath: string): void {
  expect(uuidValidate(id)).toBe(true);
  expect(uuidVersion(id)).toBe(4);
  expect(id).not.toBe(legacyProjectPathAlias(mountPath));
}

async function findOrCreateProject(mountPath: string): Promise<Project> {
  const canonicalMountPath = canonicalPosixPath(mountPath);
  const projects = await Project.query<Project>(
    new QueryRequest({ type: Project.type, query: null, scope: [], name: 'project-id-sync-dedup' }),
  );
  const existing = projects.find(
    (project) =>
      !!project.fs_storage_mount_path && canonicalPosixPath(project.fs_storage_mount_path) === canonicalMountPath,
  );
  return existing ?? new Project({ name: mountPath }).save([]);
}

describe('project id sync', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('project creation keeps its opaque uuid4 id for an absolute name', async () => {
    const mountPath = '/tmp/flow_test_proj_a';

    const p = new Project({ name: mountPath });
    const clientId = p.id;
    const saved = await p.save([]);

    expect(saved.id).toBe(clientId);
    expectOpaqueProjectId(saved.id, mountPath);
  }, 10000);

  it('project created with explicit fs_storage_mount_path', async () => {
    const mountPath = '/tmp/flow_test_proj_b';
    const canonicalMountPath = canonicalPosixPath(mountPath);

    const p = new Project({ name: 'proj_b', fs_storage_mount_path: mountPath });
    const clientId = p.id;
    const saved = await p.save([]);

    expect(saved.id).toBe(clientId);
    expectOpaqueProjectId(saved.id, mountPath);
    expect(saved.fs_storage_mount_path).toBe(canonicalMountPath);
    expect(saved.name).toBe('proj_b');
  }, 10000);

  it('find-or-create by the same work dir returns the existing entity', async () => {
    const mountPath = `/tmp/flow_test_proj_c_${uuidv4()}`;

    const saved1 = await findOrCreateProject(mountPath);
    const firstId = saved1.id;

    await dataManager.clearCache();

    const saved2 = await findOrCreateProject(mountPath);

    expect(saved2.id).toBe(firstId);
    expectOpaqueProjectId(saved2.id, mountPath);
  }, 10000);

  it('project entity has correct fields after fetch', async () => {
    const mountPath = '/tmp/flow_test_proj_d';
    const canonicalMountPath = canonicalPosixPath(mountPath);

    const p = new Project({ name: mountPath });
    const saved = await p.save([]);

    await dataManager.clearCache();
    const fetched = await Project.getById(saved.id);

    expect(fetched).toBeTruthy();
    expect(fetched!.id).toBe(saved.id);
    expectOpaqueProjectId(fetched!.id, mountPath);
    expect(fetched!.fs_storage_mount_path).toBe(canonicalMountPath);
    expect(fetched!.name).toBe('flow_test_proj_d');
  }, 10000);
});
