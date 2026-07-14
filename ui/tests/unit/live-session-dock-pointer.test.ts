/**
 * Live-session navigation identity: `/dock/live_session/<sessionId>` is a
 * top-level pointer (a guest holds a DRAFT session before any host project or
 * CollaborationRoom exists, so it can't nest under /project/…). Pins the
 * factory shape and the toJSON/fromJSON round-trip the tab strip relies on.
 */
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { RemoteWorkerSession } from '@sdk';
import { describe, expect, it } from 'vitest';

const SID = '33333333-3333-4333-8333-333333333333';

describe('DockPointer.forLiveSession', () => {
  it('builds a top-level live_session pointer carrying the session id', () => {
    const dp = DockPointer.forLiveSession(SID);
    expect(dp.viewType).toBe(ViewType.LIVE_SESSION);
    expect(dp.pointer).toBe(SID);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const dp = DockPointer.forLiveSession(SID);
    const json = dp.toJSON();
    expect(json).toBeTruthy();
    const back = DockPointer.fromJSON(json!);
    expect(back).not.toBeNull();
    expect(back!.viewType).toBe(ViewType.LIVE_SESSION);
    expect(back!.pointer).toBe(SID);
  });

  it('distinct sessions are distinct pointers', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    expect(DockPointer.forLiveSession(SID).toJSON()).not.toEqual(
      DockPointer.forLiveSession(other).toJSON(),
    );
  });

  it('targets the RemoteWorkerSession ENTITY, not the "live_session" viewType', () => {
    // The tab mints against this typeid — it must be the real entity type so the
    // tab resolves a title + project (a 'live_session' target is non-existent →
    // untitled, projectless tab). Regression for the missing-tab bug.
    const tid = DockPointer.forLiveSession(SID).targetTypeId;
    expect(tid).not.toBeNull();
    expect(tid!.type).toBe(RemoteWorkerSession.type);
    expect(tid!.type).toBe('remote_worker_session');
    expect(tid!.id).toBe(SID);
  });
});
