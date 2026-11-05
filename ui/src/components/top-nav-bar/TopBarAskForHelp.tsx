import { dataContext } from '@sdk';
import { AskForHelpButton } from '@src/components/help/AskForHelpButton';
import { useAgentContext } from '@src/contexts/agent-context';

/** Ask for help, on every screen: it belongs to none, so the session it reports is the one on screen. */
export function TopBarAskForHelp({ projectId }: { projectId: string | null }) {
  const { flow } = useAgentContext();
  if (!dataContext.caps.localFiles) return null; // the hub has no backend of its own to record the diagnosis
  return <AskForHelpButton projectId={projectId} sessionTypeId={flow?.typeId ?? null} origin="top_bar" />;
}
