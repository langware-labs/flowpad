import { ChevronDown, ChevronRight, FileText, ListChecks, Video } from 'lucide-react';
import { useState } from 'react';
import { SessionsCategory } from './sidebar/SessionsCategory';
import { DocsCategory } from './sidebar/DocsCategory';
import { PlansCategory } from './sidebar/PlansCategory';

type CategoryKey = 'sessions' | 'docs' | 'plans';

const CATEGORIES: Array<{ key: CategoryKey; label: string; icon: typeof Video }> = [
  { key: 'sessions', label: 'Sessions', icon: Video },
  { key: 'docs', label: 'Docs', icon: FileText },
  { key: 'plans', label: 'Plans', icon: ListChecks },
];

export function CollaborationSpaceSidebar() {
  const [expanded, setExpanded] = useState<Record<CategoryKey, boolean>>({
    sessions: true,
    docs: true,
    plans: false,
  });

  const toggle = (key: CategoryKey) => setExpanded((p) => ({ ...p, [key]: !p[key] }));

  return (
    <div className="flex h-full flex-col gap-1 p-2">
      {CATEGORIES.map(({ key, label, icon: Icon }) => {
        const open = expanded[key];
        return (
          <div key={key} className="flex flex-col">
            <button
              onClick={() => toggle(key)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
            </button>
            {open && (
              <div className="ml-2">
                {key === 'sessions' && <SessionsCategory />}
                {key === 'docs' && <DocsCategory />}
                {key === 'plans' && <PlansCategory />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
