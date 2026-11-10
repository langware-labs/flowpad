/** `share()` leaves the caller's own object shared, even when the cache holds another copy of the
 *  entity (a broadcast registered it while the call was in flight). It used to update only the
 *  cached copy, so `conv.remote` read false right after a share that succeeded. */
import { describe, expect, it } from 'vitest';

import { Conversation, dataManager } from '@sdk';

describe('share() and a second in-memory copy', () => {
  it("the caller's object reads as shared", () => {
    const id = '0d6f1c3e-6f0a-4c59-9a55-3a2a8d0f6b11';
    const mine = new Conversation({ id, title: 'plan' });
    const cached = dataManager.updateEntityFromJson<Conversation>({ type: 'conversation', id, title: 'plan' });
    dataManager.register_new_entity(cached.typeId, new Conversation({ id, title: 'plan' })); // the broadcast's copy
    const copy = dataManager.getByTypeIdFromCache(mine.typeId);
    expect(copy).not.toBe(mine);

    const adopt = (mine as unknown as { adoptShareResponse(r: object): Conversation }).adoptShareResponse.bind(mine);
    const shared = adopt({ type: 'conversation', id, title: 'plan', remote: true });

    expect(shared.remote).toBe(true);
    expect(mine.remote).toBe(true);
  });
});
