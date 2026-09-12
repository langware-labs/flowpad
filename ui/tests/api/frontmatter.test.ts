import { TypeId, fsManager, FSRef } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const NODE = new TypeId('compute_node', '@local');
const CONTENT = `---
id: 9fe9bee3-ce84-58c1-b047-90629fa5dfd3
name: sample
allowed-tools:
  - Read
  - Write
metadata:
  owner: team
---

Body line one.
`;
describe('asset document action', () => {
  const signupInfo = getTestSignupInfo(); let ref: FSRef;
  beforeEach(async (context) => {
    await apiTestSetup(signupInfo, context.task.name);
    ref = new FSRef(`/tmp/flow-test-document-${Date.now()}/SKILL.md`, NODE);
    await ref.write(CONTENT);
  });
  afterEach(async () => { await fsManager.delete(NODE, ref.parent.path); });
  it('preserves structured metadata when editing body', async () => {
    const before = await ref.readDocument();
    const after = await ref.updateDocument({ expected_revision: before.revision, body: 'Edited\n' });
    expect(after.fields['allowed-tools']).toEqual(['Read', 'Write']);
    expect(after.fields.metadata).toEqual({ owner: 'team' });
    expect(await ref.read()).toContain('Edited');
  });
  it('rejects a stale save without replacing externally edited bytes', async () => {
    const before = await ref.readDocument(); await ref.write(CONTENT + 'External\n');
    await expect(ref.updateDocument({ expected_revision: before.revision, body: 'Stale' })).rejects.toMatchObject({ response: { status: 409 } });
    expect(await ref.read()).toContain('External');
  });
  it('patches one typed metadata field and returns a reusable revision', async () => {
    const before = await ref.readDocument();
    const after = await ref.updateDocument({ expected_revision: before.revision, set_fields: { eval: true } });
    const final = await ref.updateDocument({ expected_revision: after.revision, set_fields: { eval: false } });
    expect(final.fields.eval).toBe(false); expect(final.fields.metadata).toEqual({ owner: 'team' });
  });
  it('repairs an exact legacy whiteboard document while preserving its board and later prose', async () => {
    const board = ref.parent.child('agentic-assets/whiteboard/legacy/board.json');
    const document = ref.parent.child('agentic-assets/whiteboard/legacy/WHITE_BOARD.md');
    const typeid = new TypeId('whiteboard', 'bc8a85f1-8ca3-4081-bcd4-5429a0e1c753');
    await board.write('{"sentinel":"preserve"}');
    await expect(document.readDocument()).rejects.toMatchObject({response: {status: 404}});
    await document.ensureDocument(typeid, {name: 'Legacy', description: 'Repair fixture'});
    const loaded = await document.readDocument();
    expect(loaded.fields.id).toBe(typeid.id);
    await document.updateDocument({expected_revision: loaded.revision, body: 'Keep my prose'});
    await document.ensureDocument(typeid, {name: 'Must not replace'});
    expect((await document.readDocument()).body).toContain('Keep my prose');
    expect(await board.read()).toBe('{"sentinel":"preserve"}');
  });

});
