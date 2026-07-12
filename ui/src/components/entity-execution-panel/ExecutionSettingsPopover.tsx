import { useMemo, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import { AgenticProcess, PrefKey, Project, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { usePreference } from '@src/hooks/use-preference';
import { Checkbox } from '@src/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';

/**
 * Execution settings. Assets intentionally live in `AssetManagerButton`; this
 * popover is for real process settings only.
 */
interface ExecutionSettingsPopoverProps {
  /** Active process or null before first send. Locks the project selector. */
  activeProcess: AgenticProcess | null;
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
  modelControl?: ReactNode;
  workerControl?: ReactNode;
  trigger: ReactNode;
}

export function ExecutionSettingsPopover({
  activeProcess,
  projectId,
  onProjectChange,
  modelControl,
  workerControl,
  trigger,
}: ExecutionSettingsPopoverProps) {
  const { t } = useLingui();
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: projects = [] } = useEntitiesQuery<Project>(projectsQuery);
  const [showTools, setShowTools] = usePreference<boolean>(PrefKey.CHAT_SHOW_TOOLS);
  const projectLocked = !!activeProcess;

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0" data-testid="execution-settings-popover">
        <div className="space-y-3 px-3 py-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
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
          {modelControl && (
            <div className="space-y-1.5" data-testid="execution-settings-model-section">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <Trans>Model</Trans>
              </div>
              {modelControl}
            </div>
          )}
          {workerControl && (
            <div className="space-y-1.5" data-testid="execution-settings-worker-section">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <Trans>Worker</Trans>
              </div>
              {workerControl}
            </div>
          )}
          <label
            className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
            data-testid="execution-settings-show-tools"
          >
            <Checkbox
              checked={!!showTools}
              onCheckedChange={(checked) => setShowTools(checked === true)}
              aria-label={t`Show tool calls`}
            />
            <span className="min-w-0 flex-1">
              <Trans>Show tool calls</Trans>
            </span>
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
