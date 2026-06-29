import { Users } from 'lucide-react';
import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { useCollaborationRooms } from '@src/hooks/useCollaborationRooms';
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

export function RoomsCategory({ projectId }: Props) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const { items, isLoading } = useCollaborationRooms({ projectId: projectId ?? undefined, limit: 20 });

  const activeRoomId = useMemo(
    () => DockPointer.parseProjectPointer(currentDock?.pointer).roomId,
    [currentDock?.pointer],
  );

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground"><Trans>No project linked</Trans></div>;
  }

  if (isLoading && items.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground"><Trans>Loading…</Trans></div>;
  }

  if (items.length === 0) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground"><Trans>No rooms yet</Trans></div>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((s) => {
        const isActive = s.id === activeRoomId;
        const isLive = s.status === 'active';
        return (
          <li
            key={s.id}
            onClick={() => {
              if (!s.projectId) return;
              navigation.openDock(DockPointer.forProject(s.projectId, { roomId: s.id }));
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Users className="h-3.5 w-3.5 flex-shrink-0" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-foreground">{s.name}</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {s.hostName ?? t('unknown host')}
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
