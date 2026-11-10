/**
 * A project open fires `checkDependencyUpdates`, which used to announce "dependencies changed"
 * every time — on success, on failure, and when nothing changed — so every view showing the
 * dependencies read them again (two dependencies GETs per open). Fetching remotes only ever moves
 * `behind` up, so only a checkout behind its remote, or a failed pull, is news.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '../../../ts_sdk/src/APIEntity';
import { onProjectDependenciesChanged, Project } from '../../../ts_sdk/src/entities/project';

const PROJECT = 'c3f1a2b4-5d6e-4f70-8a91-b2c3d4e5f607';
const dep = (extra: object = {}) => ({ name: 'd', source: 'file:x', required: true, path: 'x', state: 'ready', dismissed: false, ...extra });

function check(answer: unknown) {
  const call = vi.spyOn(dataManager, 'callAction');
  if (answer instanceof Error) call.mockRejectedValue(answer);
  else call.mockResolvedValue(answer as never);
  const heard = vi.fn();
  const off = onProjectDependenciesChanged(PROJECT, heard);
  return Project.checkDependencyUpdates(PROJECT).then(() => {
    off();
    return heard;
  });
}

describe('checkDependencyUpdates', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is silent when nothing is behind', async () => {
    expect(await check({ dependencies: [dep({ behind: 0 })] })).not.toHaveBeenCalled();
  });

  it('is silent when the check fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await check(new Error('offline'))).not.toHaveBeenCalled();
  });

  it('announces a checkout behind its remote, or a failed pull', async () => {
    expect(await check({ dependencies: [dep({ behind: 2 })] })).toHaveBeenCalledTimes(1);
    expect(await check({ dependencies: [dep({ pull_error: 'conflict' })] })).toHaveBeenCalledTimes(1);
  });
});
