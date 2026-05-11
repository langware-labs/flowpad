import { Project, dataManager } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v5 as uuidv5 } from 'uuid';
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

function expectedProjectId(mountPath: string): string {
  return uuidv5(`project:${canonicalPosixPath(mountPath)}`, UUID_NAMESPACE_DNS);
}

describe('project id sync', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('project creation assigns deterministic id from absolute name', async () => {
    const mountPath = '/tmp/flow_test_proj_a';
    const expectedId = expectedProjectId(mountPath);

    const p = new Project({ name: mountPath });
    const saved = await p.save([]);

    expect(saved.id).toBe(expectedId);
  }, 10000);

  it('project created with explicit fs_storage_mount_path', async () => {
    const mountPath = '/tmp/flow_test_proj_b';
    const canonicalMountPath = canonicalPosixPath(mountPath);
    const expectedId = expectedProjectId(mountPath);

    const p = new Project({ name: 'proj_b', fs_storage_mount_path: mountPath });
    const saved = await p.save([]);

    expect(saved.id).toBe(expectedId);
    expect(saved.fs_storage_mount_path).toBe(canonicalMountPath);
    expect(saved.name).toBe('proj_b');
  }, 10000);

  it('saving same work dir twice returns same entity', async () => {
    const mountPath = '/tmp/flow_test_proj_c';

    const p1 = new Project({ name: mountPath });
    const saved1 = await p1.save([]);
    const firstId = saved1.id;

    await dataManager.clearCache();

    const p2 = new Project({ name: mountPath });
    const saved2 = await p2.save([]);

    expect(saved2.id).toBe(firstId);
  }, 10000);

  it('project entity has correct fields after fetch', async () => {
    const mountPath = '/tmp/flow_test_proj_d';
    const canonicalMountPath = canonicalPosixPath(mountPath);
    const expectedId = expectedProjectId(mountPath);

    const p = new Project({ name: mountPath });
    await p.save([]);

    await dataManager.clearCache();
    const fetched = await Project.getById(expectedId);

    expect(fetched).toBeTruthy();
    expect(fetched!.id).toBe(expectedId);
    expect(fetched!.fs_storage_mount_path).toBe(canonicalMountPath);
    expect(fetched!.name).toBe('flow_test_proj_d');
  }, 10000);
});
