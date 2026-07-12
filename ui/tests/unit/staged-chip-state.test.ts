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
