import { Copy, Users } from 'lucide-react';
import { useToast } from '@src/hooks/use-toast';
import type { CollaborationSpace, CollaborationSpaceMember } from '@sdk';

interface Props {
  space: CollaborationSpace;
  localMemberId: string | null;
}

function onlineWithin(member: CollaborationSpaceMember, windowMs: number): boolean {
  if (!member.last_seen_at) return false;
  const t = Date.parse(member.last_seen_at);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < windowMs;
}

export function CollaborationSpaceHeader({ space, localMemberId }: Props) {
  const { toast } = useToast();
  const members = space.members ?? [];

  const copy = () => {
    if (!space.session_code) return;
    void navigator.clipboard.writeText(space.session_code);
    toast({ title: 'Code copied', description: space.session_code });
  };

  return (
    <div className="flex h-[52px] flex-shrink-0 items-center gap-3 border-b px-3">
      <Users className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-medium">
        {space.host_name ? `${space.host_name}'s space` : 'Collaboration space'}
      </span>
      {space.session_code && (
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground hover:bg-muted"
          title="Copy join code"
        >
          <span>{space.session_code}</span>
          <Copy className="h-3 w-3" />
        </button>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {members.map((m) => {
          const online = onlineWithin(m, 30_000);
          const isHost = m.member_id === space.host_member_id;
          const isSelf = m.member_id === localMemberId;
          return (
            <div
              key={m.member_id}
              title={`${m.name}${isHost ? ' (host)' : ''}${isSelf ? ' (you)' : ''}${online ? ' · online' : ''}`}
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white ${
                isHost ? 'bg-amber-500' : 'bg-sky-500'
              } ${online ? '' : 'opacity-50'}`}
            >
              {m.name.slice(0, 1).toUpperCase()}
            </div>
          );
        })}
      </div>
    </div>
  );
}
