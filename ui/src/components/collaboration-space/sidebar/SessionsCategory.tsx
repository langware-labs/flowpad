import { Video } from 'lucide-react';
import { useMemo } from 'react';
import { useCollaborationSessions } from '@src/hooks/useCollaborationSessions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

interface Props {
  projectId: string | null;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

export function SessionsCategory({ projectId }: Props) {
  const { navigation, currentDock } = useDockNavigation();
  const { items, isLoading } = useCollaborationSessions({ projectId: projectId ?? undefined, limit: 20 });

  const activeSessionId = useMemo(
    () => DockPointer.parseCollaborationSpacePointer(currentDock?.pointer).sessionId,
    [currentDock?.pointer],
  );

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }

  if (isLoading && items.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>;
  }

  if (items.length === 0) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No sessions yet</div>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((s) => {
        const isActive = s.id === activeSessionId;
        const isLive = s.status === 'active';
        return (
          <li
            key={s.id}
            onClick={() => {
              if (!s.spaceId) return;
              navigation.openDock(DockPointer.forCollaborationSpace(s.spaceId, { sessionId: s.id }));
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Video className="h-3.5 w-3.5 flex-shrink-0" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate">{s.name}</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {s.spaceName}
                {s.updatedAt && <> · {formatWhen(s.updatedAt)}</>}
              </span>
            </div>
            {isLive && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
          </li>
        );
      })}
    </ul>
  );
}
