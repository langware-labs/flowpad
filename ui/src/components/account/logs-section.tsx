import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useFlowpadAssistantProject } from '@src/components/floating-chat/useFlowpadAssistantProject';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Project } from '@sdk';
import { Terminal } from 'lucide-react';
import { SystemLog } from './system-log';
import { SystemDiagnoses } from './system-diagnoses';

export function LogsSection() {
  const { navigation } = useDockNavigation();
  // The system project that carries Flowpad's own skills, agents, docs and datasets.
  const { project: assistant } = useFlowpadAssistantProject();
  const ProjectIcon = iconForType(Project.type);

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        className="w-full"
        disabled={!assistant}
        data-testid="open-assistant-project"
        onClick={() => assistant && navigation.openProject(assistant.id)}
      >
        <ProjectIcon className="me-2 h-4 w-4" />
        <Trans>Open assistant project</Trans>
      </Button>

      <Button variant="outline" className="w-full" onClick={() => navigation.openLens('cli', 'log', 'all')}>
        <Terminal className="me-2 h-4 w-4" />
        CLI Invocation Log
      </Button>

      <SystemDiagnoses />

      <SystemLog />
    </div>
  );
}
