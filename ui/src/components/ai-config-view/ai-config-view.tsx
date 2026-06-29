import { useAgentContext } from '@src/contexts/agent-context';
import { AIConfigSubview, ViewType } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Key, Terminal, Settings } from 'lucide-react';
import React from 'react';
import { Trans } from '@lingui/react/macro';
import { ApiKeysView } from '../api-keys-view/api-keys-view';
import { CapabilitiesView } from '../capabilities-view';

export const AIConfigView: React.FC = () => {
  const { agent } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();

  // Determine active tab from navigation pointer or default to LLM_APIS
  const activeTab = (currentDock?.pointer as AIConfigSubview) || AIConfigSubview.LLM_APIS;

  // Handle tab change - update navigation with new pointer
  const handleTabChange = (value: string) => {
    const newPointer = new DockPointer(ViewType.AI_CONFIG, value as AIConfigSubview);
    navigation.openDock(newPointer);
  };

  // Get default LLM from agent config
  const defaultLLM = agent?.agent_config?.llm?.model || 'Default (System)';

  // Get default CLI - this could come from agent config or system settings
  // For now, we'll show a placeholder
  const defaultCLI = 'Default harness';

  // Handle Configure LLM button click
  const handleConfigureLLM = () => {
    handleTabChange(AIConfigSubview.LLM_APIS);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header showing defaults */}
      <div className="border-b bg-muted/30 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold"><Trans>AI Configuration</Trans></h2>
            <p className="text-xs text-muted-foreground"><Trans>Manage LLM providers and CLI integrations</Trans></p>
          </div>
          <div className="flex gap-4 text-xs">
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="font-medium"><Trans>Default LLM</Trans></div>
                <div className="text-muted-foreground">{defaultLLM}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="font-medium"><Trans>Default CLI</Trans></div>
                <div className="text-muted-foreground">{defaultCLI}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar with Configure LLM button */}
      <div className="border-b bg-background px-4 py-2">
        <Button variant="default" size="sm" onClick={handleConfigureLLM}>
          <Key className="mr-1.5 h-4 w-4" />
          <Trans>Manage API keys</Trans>
        </Button>
      </div>

      {/* Tabs for LLM APIs and CLIs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex-1">
        <div className="border-b px-2">
          <TabsList className="h-8">
            <TabsTrigger value={AIConfigSubview.LLM_APIS} className="h-7 text-xs">
              <Key className="mr-1.5 h-3.5 w-3.5" />
              <Trans>LLM APIs</Trans>
            </TabsTrigger>
            <TabsTrigger value={AIConfigSubview.CLIS} className="h-7 text-xs">
              <Terminal className="mr-1.5 h-3.5 w-3.5" />
              <Trans>Harnesses</Trans>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value={AIConfigSubview.LLM_APIS} className="mt-0 h-[calc(100%-40px)] overflow-auto p-4">
          <ApiKeysView />
        </TabsContent>

        <TabsContent value={AIConfigSubview.CLIS} className="mt-0 h-[calc(100%-40px)] overflow-auto">
          <CapabilitiesView />
        </TabsContent>
      </Tabs>
    </div>
  );
};
