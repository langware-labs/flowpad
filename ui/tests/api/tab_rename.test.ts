/**
 * Tab rename → backing-entity name sync (React API test).
 *
 * Proves the "simple wire" the UI relies on: renaming a tab (the exact call the
 * strip makes, POST /graph/tab/<id>/rename) flows into the entity that backs the
 * tab, so ``tab.name == entity.name`` whenever an entity exists.
 *
 * Backend mechanism (flow_sdk/builtin/tab.py): ``Tab.rename`` sets ``Tab.name``
 * then calls ``target.rename(name)`` — the generic ``Entity.rename`` adopts the
 * name onto ANY backing entity; ``shell``/``agentic_process`` override it to also
 * pin ``auto_rename=false`` so a PTY/worker title can't clobber the user choice.
 *
 * Coverage:
 *   - shell            (override: name mirrored + auto_rename pinned)
 *   - agentic_process  (override: name mirrored + auto_rename pinned)
 *   - conversation     (generic: ANY entity reflects via base Entity.rename)
 *
 * Runs against the running backend (LOCAL_SERVER_PORT). Real entities, real
 * HTTP, no mocks.
 */
import { AgenticProcess, Conversation, Shell, Tab, dataManager } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/** Create a Tab pointing at a backing entity, rename it through the same backend
 *  action the strip uses, and return the renamed value. */
async function renameViaTab(
  targetType: string,
  targetId: string,
  name: string,
): Promise<void> {
  const pointer = `dock/${targetType}-${targetId}`;
  // Get-or-create the Tab for this pointer (returns the updated list), then
  // rename it through the exact backend action the strip uses
  // (POST /graph/tab/<id>/rename), which reflects onto the backing entity.
  const created = await Tab.newTab(pointer, { targetType, targetId });
  const tab = created.find((t) => t.target_id === targetId);
  expect(tab).toBeTruthy();
  const updated = await Tab.renameById(tab!.id, name);
  const renamed = updated.find((t) => t.id === tab!.id);
  expect(renamed?.name).toBe(name); // Tab.name is the source of truth
}

describe('api: tab rename flows into the backing entity', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  it('shell: rename mirrors name and pins auto_rename', async () => {
    const id = uuidv4();
    await new Shell({ id, name: 'orig shell', auto_rename: true }).save();

    await renameViaTab(Shell.type, id, 'pinned shell');

    await dataManager.clearCache();
    const reloaded = await Shell.getById(id);
    expect(reloaded).toBeTruthy();
    expect(reloaded!.name).toBe('pinned shell');
    expect(reloaded!.auto_rename).toBe(false); // override pins it
  }, 15000);

  it('agentic_process: rename mirrors name and pins auto_rename', async () => {
    const id = uuidv4();
    await new AgenticProcess({
      id,
      name: 'orig process',
      auto_rename: true,
      worker_type: 'claude_code',
    } as any).save();

    await renameViaTab(AgenticProcess.type, id, 'pinned process');

    await dataManager.clearCache();
    const reloaded = await AgenticProcess.getById(id);
    expect(reloaded).toBeTruthy();
    expect(reloaded!.name).toBe('pinned process');
    expect(reloaded!.auto_rename).toBe(false); // override pins it
  }, 15000);

  it('conversation (generic entity): rename mirrors name via base Entity.rename', async () => {
    const id = uuidv4();
    await new Conversation({ id, name: 'orig conversation' }).save();

    await renameViaTab(Conversation.type, id, 'renamed conversation');

    await dataManager.clearCache();
    const reloaded = await Conversation.getById(id);
    expect(reloaded).toBeTruthy();
    expect(reloaded!.name).toBe('renamed conversation');
  }, 15000);
});
