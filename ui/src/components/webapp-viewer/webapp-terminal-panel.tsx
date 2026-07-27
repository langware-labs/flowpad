import { InteractiveTerminal } from '@src/components/terminal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { AgenticProcess, WebappSubview } from '@sdk';
import { Cloud, Terminal } from 'lucide-react';
import React from 'react';
import { WebappDeploymentsTab } from './webapp-deployments-tab';

interface WebappTerminalPanelProps {
  flow: AgenticProcess | null;
  isActive: boolean;
  activeTab: WebappSubview;
  onTabChange: (tab: WebappSubview) => void;
}

export const WebappTerminalPanel: React.FC<WebappTerminalPanelProps> = ({
  flow,
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
          <Cloud className="h-3.5 w-3.5" />
          Deployments
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
        <WebappDeploymentsTab />
      </TabsContent>
    </Tabs>
  );
};
