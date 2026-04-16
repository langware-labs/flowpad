import type { TeamSessionMember } from '@sdk';

interface MembersListProps {
  members: TeamSessionMember[];
  hostMemberId: string | null;
  currentMemberId: string | null;
  onlineWindowMs?: number;
}

function isOnline(member: TeamSessionMember, windowMs: number): boolean {
  if (!member.last_seen_at) return false;
  const t = Date.parse(member.last_seen_at);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < windowMs;
}

export function MembersList({ members, hostMemberId, currentMemberId, onlineWindowMs = 30_000 }: MembersListProps) {
  if (!members.length) {
    return (
      <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
        No members yet — share the join link to invite collaborators.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {members.map((m) => {
        const online = isOnline(m, onlineWindowMs);
        const isHost = m.member_id === hostMemberId;
        const isSelf = m.member_id === currentMemberId;
        return (
          <li
            key={m.member_id}
            className="flex items-center justify-between rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                aria-label={online ? 'online' : 'offline'}
                title={online ? 'Online' : 'Offline'}
              />
              <span className="truncate font-medium text-foreground">
                {m.name}
                {isSelf && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
              </span>
              {isHost && (
                <span className="shrink-0 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-medium leading-none text-amber-600">
                  Host
                </span>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0">
              {online ? 'Online' : 'Offline'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
