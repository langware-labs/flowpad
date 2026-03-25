import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { HistoryDropdown } from '@src/components/history-dropdown';
import { Logo } from '@src/components/logo';
import { SendToExpertButton } from '@src/components/SendToExpertButton';
import { useProcessNavigation } from '@src/hooks/use-process-navigation';
import { Button } from '@src/components/ui/button';
import { useAuth } from '@sdk/react/hooks';
import { Home, Plus } from 'lucide-react';

export function ChatPanelHeader() {
  const { agent, flow } = useAgentContext();
  const { user } = useAuth();
  const siteConfig = agent?.site_config;

  // Use the reusable flow navigation hook
  const { handleNavigateToLanding, handleResetFlow } = useProcessNavigation();

  // const handleProjectClick = (project: Project) => {
  //   const projectFlows = projectFlowsMap.get(project.id || '') || [];
  //   if (projectFlows.length > 0) {
  //     // Navigate to the most recently updated flow
  //     const mostRecentFlow = projectFlows[0];
  //     navigate(`/${agent.typeId.toUrlString()}/${mostRecentFlow.typeId.toUrlString()}`, { replace: true });
  //     clearEditorContent();
  //   }
  // };

  return (
    <div data-testid="chat-panel-header" className="flex items-center justify-between border-b bg-background p-2">
      <div className="flex items-center gap-2">
        <Logo siteConfig={siteConfig} onClick={handleNavigateToLanding} />
        <Button
          title="Home page, pro"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => handleNavigateToLanding()}
        >
          <Home className="h-4 w-4" />
        </Button>
        {/* Project select list - commented out for now, may return in the future */}
        {/* {!!currentProject && otherProjects && otherProjects?.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <div className="flex items-center gap-2">
                <span>{currentProject?.name || 'New Project'}</span>
                <ChevronDown className="h-4 w-4" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {otherProjects?.map((project) => (
                <DropdownMenuItem key={project.id} onClick={() => handleProjectClick(project)}>
                  {project.name || 'New Project'}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span>{currentProject?.name || flow?.title || 'New Project'}</span>
        )} */}
      </div>

      <div className="flex items-center gap-2">
        {flow?.id && siteConfig?.feature_flags?.enable_escalation && agent ? (
          <SendToExpertButton agentId={agent.id} processId={flow.id} />
        ) : null}

        {user ? <HistoryDropdown /> : null}

        <Button title="New Flow" variant="ghost" size="icon" className="h-8 w-8" onClick={handleResetFlow}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
