/**
 * A deep link INTO one host shares that host's tab.
 *
 * Two views carry sub-state in the PATH rather than in options: a conversation's
 * selected message (`conversation/<id>/message/<mid>`) and an app's internal
 * route (`apps/<uname>/<routerPath>`). Both are documented, deep-linkable URLs,
 * so the sub-state cannot move to options the way `forInbox`'s already has —
 * instead `foldsSubPointer` folds it out of TAB IDENTITY only.
 *
 * Without the fold, `tabHash` named a key no chip has: the strip lit nothing
 * while the conversation filled the panel, and `materializeTab` (which looks up
 * by `dock.tabHash` and mints on miss) could mint a second row per message /
 * per in-app route. Both symptoms are one bug — tab identity — so both are
 * pinned here, on the identity and on the round trip the strip dedups through.
 */
import { DockPointer } from '@src/navigation/DockPointer';
import { Tab, tabKey } from '@sdk';
import { describe, expect, it } from 'vitest';

const CONV = '92ea0ccd-04c1-4b4a-a891-37afc6c98953';
const MSG = 'c0714bd9-82c2-4ff3-a09d-96a8af32bcc0';
const OTHER_CONV = '11111111-1111-4111-8111-111111111111';

/** The key the strip compares against: what a PERSISTED row reports, not what
 *  the live URL asserts. `tabKey` is the strip's own selector, so this asks the
 *  question the way the strip asks it. Ids are unique per row because the entity
 *  registry keeps the FIRST object registered under an id — reusing one would
 *  silently re-check the previous row. */
function keyOfPersistedTab(dock: DockPointer): string {
  return tabKey(new Tab({ id: `row-${rowSeq++}`, pointer: dock.toJSON() ?? '' }));
}
let rowSeq = 0;

describe('conversation: a message deep link is the conversation tab', () => {
  it('tabHash folds the message out', () => {
    expect(DockPointer.forConversation(CONV, { messageId: MSG }).tabHash).toBe(`conversation|${CONV}`);
    expect(DockPointer.forConversation(CONV).tabHash).toBe(`conversation|${CONV}`);
  });

  it('two conversations are still two tabs', () => {
    expect(DockPointer.forConversation(CONV).tabHash).not.toBe(DockPointer.forConversation(OTHER_CONV).tabHash);
  });

  it('thread and agent options keep folding too (they always did)', () => {
    expect(DockPointer.forConversation(CONV, { messageId: MSG, thread: 't1', agentId: 'a1' }).tabHash).toBe(
      `conversation|${CONV}`,
    );
  });

  it('the message stays in the URL — only identity folds', () => {
    const dock = DockPointer.forConversation(CONV, { messageId: MSG });
    expect(dock.pointer).toBe(`${CONV}/message/${MSG}`);
    expect(DockPointer.parseConversationPointer(dock.pointer).messageId).toBe(MSG);
  });

  it('a row minted from a message deep link reports the conversation key', () => {
    expect(keyOfPersistedTab(DockPointer.forConversation(CONV, { messageId: MSG }))).toBe(`conversation|${CONV}`);
  });

  it('a URL parsed back from the wire folds the same way', () => {
    const dock = DockPointer.fromUrl(`/dock/conversation/${CONV}/message/${MSG}`);
    expect(dock.tabHash).toBe(`conversation|${CONV}`);
  });
});

describe('apps: an in-app route is the app tab', () => {
  it('tabHash folds the router path out', () => {
    expect(DockPointer.forApp('my-app', 'settings/advanced').tabHash).toBe('apps|my-app');
    expect(DockPointer.forApp('my-app').tabHash).toBe('apps|my-app');
  });

  it('two apps are still two tabs', () => {
    expect(DockPointer.forApp('my-app', 'x').tabHash).not.toBe(DockPointer.forApp('other-app', 'x').tabHash);
  });

  it('the router path stays in the URL — only identity folds', () => {
    const dock = DockPointer.forApp('my-app', 'settings/advanced');
    expect(dock.pointer).toBe('my-app/settings/advanced');
    expect(DockPointer.parseAppPointer(dock.pointer)?.routerPath).toBe('settings/advanced');
  });

  it('a row minted from a deep in-app route reports the app key', () => {
    expect(keyOfPersistedTab(DockPointer.forApp('my-app', 'settings/advanced'))).toBe('apps|my-app');
  });
});

describe('the fold is opt-in, not a new default', () => {
  it('a plain multi-segment pointer still keys on the whole pointer', () => {
    // LENS is `category/type/ref` — three segments of IDENTITY, not sub-state.
    expect(DockPointer.forLens('claude', 'transcript', 'abc').tabHash).toBe('lens|claude/transcript/abc');
  });

  /**
   * The fold is computed when a dock is BUILT, not when a row is read: `Tab.getKey`
   * reads the stored pointer through `withCanonicalTabHash`, which never runs
   * `DockPointer.tabHash`. So a row persisted BEFORE this fold existed keeps its
   * unfolded key and stays a separate chip — the fix stops new ones, it does not
   * heal old ones. Pinned so the need for a data migration is a stated fact rather
   * than a surprise, and so nobody "fixes" this by folding at read time (that would
   * change the key of every legacy row the backend still addresses by uuid5).
   */
  it('a row persisted before the fold keeps its unfolded key', () => {
    const legacy = JSON.stringify({ viewType: 'conversation', pointer: `${CONV}/message/${MSG}` });
    expect(tabKey(new Tab({ id: `row-${rowSeq++}`, pointer: legacy }))).toBe(`conversation|${CONV}/message/${MSG}`);
  });
});
