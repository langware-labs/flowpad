/**
 * Regression test for "conversation tab opens as 'Conversation', not its name".
 *
 * Repro: open /dock/conversation/<id> for the first time. react-router splits
 * that URL into viewType="conversation" and pointer="<bare-uuid>" (the type
 * lives in the viewType, NOT in the pointer). `getTabName` only resolves an
 * entity when the pointer ITSELF carries the type (`<type>-<id>` or
 * `…/typeid/<type>-<id>`); it never folds `dock.viewType` into the TypeId. So
 * `new TypeId('<bare-uuid>')` throws, getTabName returns null, and the strip
 * falls back to the viewType title "Conversation" instead of the entity name.
 *
 * On/off switch (proven live): same conversation entity in cache —
 *   pointer '<bare-uuid>'              → getTabName === null            (bug)
 *   pointer 'conversation-<bare-uuid>' → getTabName === entity.name     (works)
 *
 * Fix belongs in `DataManager.getTabName` (and its twin `targetForDock`):
 * when the pointer is a bare entity id and `dock.viewType` is an entity type,
 * resolve via `new TypeId(dock.viewType, pointer)`.
 */

import { DataManager, TypeId } from '@sdk';
import { describe, expect, it } from 'vitest';

const CONV_ID = '4bd1c4e5-793b-445f-86c5-226f8d6b8b8f';
const CONV_NAME = 'Design sync standup';

function seedConversation(): DataManager<any> {
  const dm = new DataManager<any>();
  const tid = new TypeId('conversation', CONV_ID);
  dm.register_new_entity(tid, { typeId: tid, type: 'conversation', id: CONV_ID, name: CONV_NAME });
  return dm;
}

describe('getTabName — entity-backed dock with a bare-id pointer (/dock/conversation/<id>)', () => {
  it('resolves the conversation name from viewType + bare-uuid pointer', () => {
    const dm = seedConversation();
    // This is the shape react-router produces for /dock/conversation/<id>.
    expect(dm.getTabName({ viewType: 'conversation', pointer: CONV_ID })).toBe(CONV_NAME);
  });

  it('sanity: the typed-pointer form already resolves the same name', () => {
    const dm = seedConversation();
    expect(dm.getTabName({ viewType: 'conversation', pointer: `conversation-${CONV_ID}` })).toBe(CONV_NAME);
  });
});

/**
 * Regression: an un-stamped AgenticProcess whose `displayName` is only the
 * `<type>-<id>` synthetic must NOT become a tab name — returning it would freeze
 * `agentic_process-<id>` into the durable `Tab.name`. `getTabName` reads the
 * entity's `hasSyntheticDisplayName` sentinel and returns null so the chip falls
 * back to the provider label until a real name is stamped.
 */
const AP_ID = '94dbca09-85e6-42c5-b8a7-c2153d26a11d';

describe('getTabName — never adopts the <type>-<id> synthetic as a tab name', () => {
  it('returns null when the cached process reports a synthetic displayName', () => {
    const dm = new DataManager<any>();
    const tid = new TypeId('agentic_process', AP_ID);
    dm.register_new_entity(tid, {
      typeId: tid,
      type: 'agentic_process',
      id: AP_ID,
      name: null,
      displayName: 'agentic_process-94db…a11d',
      hasSyntheticDisplayName: true,
    });
    expect(dm.getTabName({ viewType: 'shell', pointer: `agentic_process-${AP_ID}` })).toBeNull();
  });

  it('returns the real name once the process carries one (not synthetic)', () => {
    const dm = new DataManager<any>();
    const tid = new TypeId('agentic_process', AP_ID);
    dm.register_new_entity(tid, {
      typeId: tid,
      type: 'agentic_process',
      id: AP_ID,
      name: 'Base directory spec',
      displayName: 'Base directory spec',
      hasSyntheticDisplayName: false,
    });
    expect(dm.getTabName({ viewType: 'shell', pointer: `agentic_process-${AP_ID}` })).toBe('Base directory spec');
  });
});
