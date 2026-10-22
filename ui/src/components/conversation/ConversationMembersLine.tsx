import { Trans } from '@lingui/react/macro';
import type { TypeId } from '@sdk';
import { useMembers } from '@src/hooks/use-members';

/** Email-style sub-header: every member of the conversation, name + address,
 *  spread across one wrapping line. */
export function ConversationMembersLine({ typeId }: { typeId: TypeId }) {
  const { members } = useMembers(typeId);
  if (!members.length) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 border-b px-3 py-1 text-xs">
      <span className="text-muted-foreground">
        <Trans>Members:</Trans>
      </span>
      {members.map((m, i) => {
        const name = m.name || m.email || m.user_id || '';
        return (
          <span key={m.user_id || m.email || i} className="min-w-0 truncate">
            <span className="font-medium text-foreground">{name}</span>
            {m.email && m.email !== name && <span className="text-muted-foreground"> &lt;{m.email}&gt;</span>}
          </span>
        );
      })}
    </div>
  );
}
