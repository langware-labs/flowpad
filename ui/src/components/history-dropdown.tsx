import { useProcessHistory } from '@src/hooks/use-process-history';
import { Flow, navigator, timeAgo } from '@sdk';
import { Button } from '@src/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';
import { History } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAgentContext } from './agent-layout/agent-layout';

export function HistoryDropdown() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { agent, flow, project } = useAgentContext();
  const projectTypeId = project?.typeId;

  const { data: flows } = useProcessHistory();
  const sortedFlows = useMemo(() => {
    return flows
      ?.filter((f) => !flow?.typeId || !f.typeId.equals(flow.typeId))
      .filter((f) => !projectTypeId || f.projectTypeId?.equals(projectTypeId))
      .sort(Flow.compare('updated_date'));
  }, [flows, flow?.typeId, projectTypeId]);

  return (
    <DropdownMenu data-testid="history-dropdown">
      <DropdownMenuTrigger asChild>
        <Button title={t`Flow History`} variant="ghost" size="icon" className="h-8 w-8">
          <History className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="px-2 py-1.5 text-sm font-medium"><Trans>Flow History</Trans></div>
        <DropdownMenuSeparator />
        <div className="max-h-80 overflow-y-auto">
          {sortedFlows?.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground"><Trans>Nothing yet!</Trans></div>
          ) : (
            sortedFlows?.map((flow) => (
              <DropdownMenuItem
                key={flow.id}
                className="flex cursor-pointer flex-col items-start gap-1 p-2"
                onClick={() => {
                  const urlPath = navigator.getUrlPath(flow.typeId, agent?.typeId);
                  void navigate(urlPath);
                }}
              >
                <div className="text-xs font-medium">{flow.title || t`New Flow`}</div>

                {flow?.created_date ? (
                  <div className="text-xs text-muted-foreground">{timeAgo(flow?.created_date)}</div>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
