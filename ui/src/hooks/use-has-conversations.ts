import { Conversation, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Does this instance have ANY conversation? The existence gate for the rail's
 * Inbox icon — an inbox nobody has ever written to is a door onto an empty room.
 *
 * `limit: 1` deliberately: the answer is a boolean, so the row itself is never
 * read. This is the same query shape InboxView mounts
 * (`components/inbox-view/InboxView.tsx`), capped — the rail is mounted on every
 * screen and must not carry the full list.
 *
 * Reactive: useEntitiesQuery's watchQuery re-validates on the Conversation
 * data_op that a first conversation emits, so the icon appears without a reload.
 */
export function useHasConversations(): boolean {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Conversation.type,
        name: 'railHasConversations',
        query: new QueryFilter({ limit: 1 }),
      }),
    [],
  );
  const { data } = useEntitiesQuery<Conversation>(request);
  return (data?.length ?? 0) > 0;
}
