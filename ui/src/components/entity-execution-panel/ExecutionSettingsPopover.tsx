import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
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
 * Execution-flavored asset manager. Wraps the reusable `AssetManagerPopover`
 * and adds a Project selector in the footer.
 *
 * Props are kept stable for existing callers — the implementation delegates
 * to `AssetManagerPopover` for the asset list and attach/detach.
 */
interface ExecutionSettingsPopoverProps {
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

export function ExecutionSettingsPopover({
  attachedRefs,
  onAttach,
  onDetach,
  activeProcess,
  projectId,
  onProjectChange,
  trigger,
}: ExecutionSettingsPopoverProps) {
  const { t } = useLingui();
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
        <div className="space-y-1.5 px-3 py-2" data-testid="execution-settings-project-section">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <Trans>Project</Trans>
            </div>
            {projectLocked && (
              <span className="text-[10px] text-muted-foreground">
                <Trans>locked after first message</Trans>
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
              data-testid="execution-settings-project"
              title={
                projectLocked
                  ? t`Project is fixed after the first message — start a new session to change it.`
                  : undefined
              }
            >
              <SelectValue placeholder={t`Select project`} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id!}>
                  {p.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    />
  );
}
