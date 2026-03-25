import { InteractiveTerminal } from '@src/components/terminal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { Artifact, Flow, MachineStatus, WebappSubview } from '@sdk';
import { Boxes, Terminal } from 'lucide-react';
import React from 'react';
import { WebappArtifactsTab } from './webapp-artifacts-tab';

interface WebappTerminalPanelProps {
  flow: Flow | null;
  artifacts: Artifact[];
  machineStatus: MachineStatus | null;
  isActive: boolean;
  activeTab: WebappSubview;
  onTabChange: (tab: WebappSubview) => void;
}

export const WebappTerminalPanel: React.FC<WebappTerminalPanelProps> = ({
  flow,
  artifacts,
  machineStatus,
  isActive,
  activeTab,
  onTabChange,
}) => {
  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as WebappSubview)} className="flex h-full flex-col">
      <TabsList className="h-8 w-full justify-start rounded-none border-b bg-transparent px-2">
        <TabsTrigger
          value={WebappSubview.SHELL}
          className="h-7 gap-1.5 rounded-sm px-3 text-xs data-[state=active]:bg-muted"
        >
          <Terminal className="h-3.5 w-3.5" />
          Run Shell
        </TabsTrigger>
        <TabsTrigger
          value={WebappSubview.ARTIFACTS}
          className="h-7 gap-1.5 rounded-sm px-3 text-xs data-[state=active]:bg-muted"
        >
          <Boxes className="h-3.5 w-3.5" />
          Artifacts
        </TabsTrigger>
      </TabsList>

      <TabsContent value={WebappSubview.SHELL} className="mt-0 flex-1 overflow-hidden">
        <InteractiveTerminal
          sessionId="run"
          flow={flow}
          active={isActive && activeTab === WebappSubview.SHELL}
          className="h-full"
        />
      </TabsContent>

      <TabsContent value={WebappSubview.ARTIFACTS} className="mt-0 flex-1 overflow-hidden">
        <WebappArtifactsTab artifacts={artifacts} machineStatus={machineStatus} />
      </TabsContent>
    </Tabs>
  );
};
