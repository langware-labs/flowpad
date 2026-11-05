import { AskForHelpButton } from '@src/components/help/AskForHelpButton';
import { useAgentContext } from '@src/contexts/agent-context';
import { isHubOnly } from '@src/navigation/hub-runtime';

/** Ask for help, on every screen: it belongs to none, so the session it reports is the one on screen. */
export function TopBarAskForHelp({ projectId }: { projectId: string | null }) {
  const { flow } = useAgentContext();
  if (isHubOnly()) return null;
  return <AskForHelpButton projectId={projectId} sessionTypeId={flow?.typeId ?? null} origin="top_bar" />;
}
