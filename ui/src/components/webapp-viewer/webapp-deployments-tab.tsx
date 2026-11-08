import { Trans } from '@lingui/react/macro';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { ProjectDeploymentsPage } from '@src/components/project-deployments/ProjectDeploymentsPage';
import { useContext } from '@src/hooks/useContext';
import React from 'react';

/** The web app's Deployments tab: its project's deployments — the same page the project dock opens. */
export const WebappDeploymentsTab: React.FC = () => {
  const { project } = useContext();
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Open a project to see its deployments</Trans>
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-3">
        <ProjectDeploymentsPage project={project} />
      </div>
    </ScrollArea>
  );
};
