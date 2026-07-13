import { Project, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useEntity } from '@src/hooks/entity-hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useProjectSecretOrigins } from '@src/hooks/use-project-secret-origins';
import { Plus, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { BindSecretDialog } from './BindSecretDialog';

interface SecretsProps {
  spawnProjectId?: string | null;
}

/**
 * Secrets — the ProjectHome card listing the project's secret bindings.
 * Renders nothing until the project has at least one binding — the first
 * secret is bound via the quick-create "Secret" tile, so an empty project
 * home stays uncluttered. The bind flow (enablement + form) lives in
 * {@link BindSecretDialog}, shared with quick-create.
 */
export const Secrets: React.FC<SecretsProps> = ({ spawnProjectId }) => {
  const { t } = useLingui();
  const dataCtx = useDataContext();
  const spawnTypeId = useMemo(
    () => (spawnProjectId ? new TypeId(Project.type, spawnProjectId) : null),
    [spawnProjectId],
  );
  const { data: pinnedProject } = useEntity<Project>(spawnTypeId, { watch: true, enabled: !!spawnTypeId });
  const project = pinnedProject ?? dataCtx.project;
  const { secretOrigins, remove } = useProjectSecretOrigins(project);

  const [open, setOpen] = useState(false);

  if (!project || secretOrigins.length === 0) return null;

  return (
    <div className="flex w-full max-w-md flex-col gap-2" data-testid="project-secrets">
      <div className="flex items-center justify-between gap-2">
        <span className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Trans>Secrets</Trans>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setOpen(true)}
          title={t`Bind secret`}
          data-testid="project-secret-add"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        {secretOrigins.map((origin) => (
          <div
            key={origin.typeid}
            className="flex items-center gap-2 rounded border bg-muted/30 px-2.5 py-1.5"
            data-testid={`project-secret-row-${origin.typeid}`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs text-foreground" title={origin.env_var}>
                {origin.env_var}
              </div>
              <div className="truncate text-[11px] text-muted-foreground" title={origin.name}>
                {origin.name}
              </div>
            </div>
            <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
              {origin.scope === 'shared' ? <Trans>Shared</Trans> : <Trans>Private</Trans>}
            </span>
            <button
              type="button"
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void remove(origin.typeid)}
              title={t`Remove secret binding`}
              data-testid={`project-secret-remove-${origin.typeid}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      <BindSecretDialog project={project} open={open} onOpenChange={setOpen} />
    </div>
  );
};
