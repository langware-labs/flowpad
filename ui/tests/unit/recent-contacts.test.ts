/** The picker's "recent" rows: the people of the latest conversations, newest first, each once. */
import { describe, expect, it } from 'vitest';
import { type Conversation, User } from '@sdk';
import { recentContacts } from '@src/components/contact-picker/use-recent-contacts';

const alice = new User({ id: '11111111-1111-4111-8111-111111111111', user_id: 'hub-alice', email: 'alice@x.io', name: 'Alice' });
const bob = new User({ id: '22222222-2222-4222-8222-222222222222', email: 'bob@x.io', name: 'Bob' });
const carol = new User({ id: '33333333-3333-4333-8333-333333333333', user_id: 'hub-carol', name: 'Carol' });

const conversation = (id: string, members: object[]) => ({ id, members }) as unknown as Conversation;

describe('recentContacts', () => {
  it('lists contacts in conversation order, once each, matched by hub id or email', () => {
    const rows = recentContacts(
      [alice, bob, carol],
      [
        conversation('44444444-4444-4444-8444-444444444441', [{ user_id: 'hub-me' }, { email: 'Bob@x.io' }]),
        conversation('44444444-4444-4444-8444-444444444442', [{ user_id: 'hub-carol' }, { email: 'bob@x.io' }]),
        conversation('44444444-4444-4444-8444-444444444443', [{ email: 'alice@x.io' }]),
      ],
    );
    expect(rows).toEqual([bob, carol, alice]);
  });

  it('stops at the limit', () => {
    const rows = recentContacts(
      [alice, bob, carol],
      [conversation('44444444-4444-4444-8444-444444444441', [{ user_id: 'hub-alice' }, { email: 'bob@x.io' }, { user_id: 'hub-carol' }])],
      2,
    );
    expect(rows).toEqual([alice, bob]);
  });
});
