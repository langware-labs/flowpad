import { useMemo } from 'react';
import { AgenticProcess, Project, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { AssetManagerPopover } from '@src/components/asset-manager';

/**
 * Chat-flavored asset manager. Wraps the reusable `AssetManagerPopover` and
 * adds a chat-specific Project selector in the footer.
 *
 * Props are kept stable for the existing chat callers — the implementation
 * delegates to `AssetManagerPopover` for the asset list and attach/detach.
 */
interface ChatSettingsPopoverProps {
  /** `agent-<id>` / `skill-<id>` strings — serialized TypeIds. */
  attachedRefs: string[];
  onAttach: (ref: string) => void | Promise<void>;
  onDetach: (ref: string) => void | Promise<void>;
  /** Active process or null before first send. Locks the project selector. */
  activeProcess: AgenticProcess | null;
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
  trigger: React.ReactNode;
}

export function ChatSettingsPopover({
  attachedRefs,
  onAttach,
  onDetach,
  activeProcess,
  projectId,
  onProjectChange,
  trigger,
}: ChatSettingsPopoverProps) {
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: projects = [] } = useEntitiesQuery<Project>(projectsQuery);
  const projectLocked = !!activeProcess;

  return (
    <AssetManagerPopover
      process={activeProcess}
      attachedRefs={attachedRefs}
      onAttach={onAttach}
      onDetach={onDetach}
      trigger={trigger}
      footer={
        <div className="space-y-1.5 px-3 py-2" data-testid="chat-settings-project-section">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Project
            </div>
            {projectLocked && (
              <span className="text-[10px] text-muted-foreground">
                locked after first message
              </span>
            )}
          </div>
          <Select
            value={projectId ?? ''}
            onValueChange={(v) => onProjectChange(v || null)}
            disabled={projectLocked}
          >
            <SelectTrigger
              className="h-7 text-xs"
              data-testid="chat-settings-project"
              title={
                projectLocked
                  ? 'Project is fixed after the first message — start a new chat to change it.'
                  : undefined
              }
            >
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id!}>
                  {p.displayName ?? p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    />
  );
}
