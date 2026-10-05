import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useFlowpadAssistantProject } from '@src/components/floating-chat/useFlowpadAssistantProject';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Dataset, editorsFor, Project, QueryRequest, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { Terminal } from 'lucide-react';

/** The SmartNavigationLog dataset's title (`flow_sdk/core/navigation_log.py` TITLE). */
const SMART_NAVIGATION_LOG = 'SmartNavigationLog';
import { SystemLog } from './system-log';
import { SystemDiagnoses } from './system-diagnoses';

export function LogsSection() {
  const { navigation } = useDockNavigation();
  // The system project that carries Flowpad's own skills, agents, docs and datasets.
  const { project: assistant } = useFlowpadAssistantProject();
  const ProjectIcon = iconForType(Project.type);
  const DatasetIcon = iconForType(Dataset.type);

  // The log opens in the app that edits it, like any dataset (record-type-nav's dataset action).
  // None yet means the log was never on: send the user to the switch (Preferences → Advanced).
  const openSmartNavigationLog = async () => {
    const [log] = await Dataset.query(
      new QueryRequest({
        type: Dataset.type,
        query: { name: SMART_NAVIGATION_LOG },
        scope: [],
        name: 'smart-navigation-log',
      }),
    );
    if (!log) {
      navigation.openPreferences('advanced');
      return;
    }
    const subject = `dataset-${log.id}`;
    const [editor] = await editorsFor(subject);
    if (editor) navigation.openDock(DockPointer.forAppEntity(new TypeId(editor.typeid), { subject }));
  };

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

      <Button
        variant="outline"
        className="w-full"
        data-testid="open-smart-navigation-log"
        onClick={() => void openSmartNavigationLog()}
      >
        <DatasetIcon className="me-2 h-4 w-4" />
        <Trans>Smart Navigation Log</Trans>
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
