import { describe, expect, it } from 'vitest';
import { MessageAttachment } from '@sdk/entities/message-attachment';
import { chipStateFor } from '@src/components/conversation/useMessageAttachments';

const staged = new MessageAttachment({ id: '66666666-6666-4666-8666-666666666666', scope: null });
const installed = new MessageAttachment({ id: '77777777-7777-4777-8777-777777777777', scope: 'user' });

/**
 * Chip truth table for a TYPE_ID attachment under staged reception:
 *   entity resolves            → installed (solid, navigates)
 *   no entity + MA row         → staged (dashed, opens review modal)
 *   no entity + no MA + hidden → hidden (Download button carries it)
 *   no entity + no MA + shown  → unavailable (muted 404 chip)
 */
describe('chipStateFor', () => {
  it('entity resolved wins regardless of MA', () => {
    expect(chipStateFor(true, undefined, false)).toBe('installed');
    expect(chipStateFor(true, staged, true)).toBe('installed');
  });

  it('staged when an MA row exists and the entity does not resolve', () => {
    expect(chipStateFor(false, staged, false)).toBe('staged');
    expect(chipStateFor(false, staged, true)).toBe('staged');
  });

  it('installed-but-not-yet-synced MA still renders staged until the entity lands', () => {
    // The asset CREATE data-op may lag the MA UPDATE — dashes until it resolves.
    expect(chipStateFor(false, installed, true)).toBe('staged');
  });

  it('hidden pre-download; unavailable once forced visible with nothing local', () => {
    expect(chipStateFor(false, undefined, false)).toBe('hidden');
    expect(chipStateFor(false, undefined, true)).toBe('unavailable');
  });
});

/**
 * TASK rows: unpack materializes a slim Task row immediately (the conversation
 * branch needs it for its perm-dir slug), so entity resolution would mark a
 * staged task installed before the user ever reviewed it. Installed-ness must
 * come from the MA row, like raw files.
 */
describe('chipStateFor — task rows', () => {
  const taskStaged = new MessageAttachment({
    id: 'aaaaaaa1-1111-4111-8111-111111111111', asset_type: 'task', scope: null,
  });
  const taskInstalled = new MessageAttachment({
    id: 'aaaaaaa2-2222-4222-8222-222222222222', asset_type: 'task', scope: 'project',
  });

  it('stays staged while the slim row already resolves', () => {
    expect(chipStateFor(true, taskStaged, true)).toBe('staged');
  });

  it('installed follows the MA scope', () => {
    expect(chipStateFor(true, taskInstalled, true)).toBe('installed');
    expect(chipStateFor(false, taskInstalled, true)).toBe('installed');
  });

  it('no MA row keeps the plain-share behavior (entity resolution wins)', () => {
    expect(chipStateFor(true, undefined, true)).toBe('installed');
  });
});

/**
 * Raw FILE rows (asset_type='file' — the OS-file-picker lane) never resolve as
 * entities: installed-ness comes from the MA row itself (`ma.installed`), not
 * entity resolution. Regression for the SAPAK-DEMO-SPEC.md case where a
 * downloaded file could never surface in a projectless conversation.
 */
describe('chipStateFor — raw file rows', () => {
  const fileStaged = new MessageAttachment({
    id: '88888888-8888-4888-8888-888888888888', asset_type: 'file', scope: null,
  });
  const fileInstalledUser = new MessageAttachment({
    id: '99999999-9999-4999-8999-999999999999', asset_type: 'file', scope: 'user',
  });
  const fileInstalledProject = new MessageAttachment({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', asset_type: 'file', scope: 'project',
  });

  it('staged until installed', () => {
    expect(chipStateFor(false, fileStaged, false)).toBe('staged');
    expect(chipStateFor(false, fileStaged, true)).toBe('staged');
  });

  it('installed from the MA row scope — entity resolution is irrelevant', () => {
    expect(chipStateFor(false, fileInstalledUser, false)).toBe('installed');
    expect(chipStateFor(false, fileInstalledProject, true)).toBe('installed');
  });
});
