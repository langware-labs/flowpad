import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { isHiddenProject, type Agent } from '@sdk';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useProjects } from '@src/hooks/use-projects';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

interface AgentProjectPickerProps {
  agent: Agent;
  onMoved: (projectId: string) => void;
}

/** The fix for an agent in no project: pick one, and the agent's folder moves into it. */
export function AgentProjectPicker({ agent, onMoved }: AgentProjectPickerProps) {
  const { t } = useLingui();
  const { projects = [] } = useProjects();
  const [moving, setMoving] = useState(false);

  const move = async (projectId: string) => {
    setMoving(true);
    try {
      await agent.moveToProject(projectId);
      onMoved(projectId);
    } catch (e) {
      notify.error({ title: t`Could not move the agent`, message: errorMessage(e, t`It failed.`), forceToast: true });
    } finally {
      setMoving(false);
    }
  };

  return (
    <Select disabled={moving} onValueChange={(id) => void move(id)}>
      <SelectTrigger className="h-6 w-36 text-xs" data-testid="agent-deploy-action-project">
        <SelectValue placeholder={t`Choose a project`} />
      </SelectTrigger>
      <SelectContent>
        {projects
          .filter((p) => !isHiddenProject(p))
          .map((p) => (
            <SelectItem key={p.id} value={p.id} data-testid={`agent-deploy-project-${p.id}`}>
              {p.displayName}
            </SelectItem>
          ))}
        {projects.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            <Trans>No projects yet</Trans>
          </p>
        )}
      </SelectContent>
    </Select>
  );
}
