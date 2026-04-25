import { ChevronDown, ChevronRight, FileText, ListChecks, Video } from 'lucide-react';
import { useState } from 'react';
import { RoomsCategory } from './sidebar/RoomsCategory';
import { DocsCategory } from './sidebar/DocsCategory';
import { NewDocButton } from './sidebar/NewDocButton';
import { PlansCategory } from './sidebar/PlansCategory';
import type { RoomTab } from './RoomTabs';

type CategoryKey = 'rooms' | 'docs' | 'plans';

const CATEGORIES: Array<{ key: CategoryKey; label: string; icon: typeof Video }> = [
  { key: 'rooms', label: 'Rooms', icon: Video },
  { key: 'docs', label: 'Docs', icon: FileText },
  { key: 'plans', label: 'Plans', icon: ListChecks },
];

interface Props {
  projectId: string | null;
  onOpenTab?: (tab: RoomTab) => void;
}

export function CollaborationSidebar({ projectId, onOpenTab }: Props) {
  const [expanded, setExpanded] = useState<Record<CategoryKey, boolean>>({
    rooms: true,
    docs: true,
    plans: false,
  });
  const [docsRefreshKey, setDocsRefreshKey] = useState(0);

  const toggle = (key: CategoryKey) => setExpanded((p) => ({ ...p, [key]: !p[key] }));

  return (
    <div className="flex h-full flex-col gap-1 p-2">
      {CATEGORIES.map(({ key, label, icon: Icon }) => {
        const open = expanded[key];
        return (
          <div key={key} className="flex flex-col">
            <div className="flex items-center gap-1 rounded-md pr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted hover:text-foreground">
              <button
                type="button"
                onClick={() => toggle(key)}
                className="flex flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </button>
              {key === 'docs' && (
                <NewDocButton
                  projectId={projectId}
                  onCreated={() => setDocsRefreshKey((k) => k + 1)}
                  onOpenTab={onOpenTab}
                />
              )}
            </div>
            {open && (
              <div className="ml-2">
                {key === 'rooms' && <RoomsCategory projectId={projectId} />}
                {key === 'docs' && (
                  <DocsCategory projectId={projectId} refreshKey={docsRefreshKey} onOpenTab={onOpenTab} />
                )}
                {key === 'plans' && <PlansCategory projectId={projectId} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
