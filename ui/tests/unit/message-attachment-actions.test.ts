import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk';
import { MessageAttachment } from '@sdk/entities/message-attachment';
import type { ActionInfo } from '@sdk/models/ActionInfo';
import { unitTestSetup } from '../utils/test-utils';

const MA_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

function lastAction(spy: ReturnType<typeof vi.spyOn>): ActionInfo {
  return spy.mock.calls[spy.mock.calls.length - 1][0] as ActionInfo;
}

/** MessageAttachment install/uninstall/read dispatch contracts (ActionInfo shape). */
describe('MessageAttachment actions', () => {
  beforeEach(async () => {
    await unitTestSetup();
  });

  it('install(project, id) POSTs the install action with scope + project_id', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as never);
    const ma = new MessageAttachment({ id: MA_ID });

    await ma.install('project', PROJECT_ID);

    const action = lastAction(spy);
    expect(action.name).toBe('install');
    expect(action.method).toBe('POST');
    expect(action.targetEntity?.toString()).toBe(`message_attachment-${MA_ID}`);
    expect(action.bodyParameters).toEqual({ scope: 'project', project_id: PROJECT_ID, overwrite: false });
  });

  it('install(user) POSTs scope=user with null project_id; overwrite plumbs through', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as never);
    const ma = new MessageAttachment({ id: MA_ID });

    await ma.install('user', undefined, { overwrite: true });

    expect(lastAction(spy).bodyParameters).toEqual({ scope: 'user', project_id: null, overwrite: true });
  });

  it('uninstall POSTs the uninstall action on the entity', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as never);
    const ma = new MessageAttachment({ id: MA_ID });

    await ma.uninstall();

    const action = lastAction(spy);
    expect(action.name).toBe('uninstall');
    expect(action.method).toBe('POST');
    expect(action.targetEntity?.toString()).toBe(`message_attachment-${MA_ID}`);
  });

  it('listStagedFiles / readStagedFile GET the staged read surface', async () => {
    const spy = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({ files: [], main_file: null, root: '', abs_root: '/tmp/x' } as never);
    const ma = new MessageAttachment({ id: MA_ID });

    await ma.listStagedFiles();
    expect(lastAction(spy).name).toBe('staged-files');
    expect(lastAction(spy).method).toBe('GET');

    await ma.readStagedFile('SKILL.md');
    const action = lastAction(spy);
    expect(action.name).toBe('staged-file-content');
    expect(action.queryParameters).toEqual({ path: 'SKILL.md' });
  });

  it('targetTypeId + installed getters', () => {
    const ma = new MessageAttachment({
      id: MA_ID,
      asset_type: 'skill',
      asset_id: '55555555-5555-4555-8555-555555555555',
    });
    expect(ma.targetTypeId?.toString()).toBe('skill-55555555-5555-4555-8555-555555555555');
    expect(ma.installed).toBe(false);
    ma.scope = 'user';
    expect(ma.installed).toBe(true);
    expect(new MessageAttachment({ id: MA_ID }).targetTypeId).toBeNull();
  });

  it('raw file row: same install/uninstall contract + installed getter', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as never);
    const fileId = '66666666-6666-4666-8666-666666666666';
    const ma = new MessageAttachment({
      id: MA_ID,
      asset_type: 'file',
      asset_id: fileId,
      name: 'SAPAK-DEMO-SPEC.md',
    });

    // Contract identical to entity rows.
    await ma.install('project', PROJECT_ID);
    expect(lastAction(spy).bodyParameters).toEqual({ scope: 'project', project_id: PROJECT_ID, overwrite: false });
    expect(ma.targetTypeId?.toString()).toBe(`file-${fileId}`);

    // Installed-ness comes from the row's scope (a file never resolves as an entity).
    expect(ma.installed).toBe(false);
    ma.scope = 'project';
    expect(ma.installed).toBe(true);
  });
});
