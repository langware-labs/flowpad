import { useLingui } from '@lingui/react/macro';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { AgentResourcesBody } from './AgentResourcesBody';
import { useAgentDocument } from './useAgentDocument';

/**
 * Agent-resources left-menu — the navigator (Zone B) while an agent is being
 * created or edited. Replaces the assets tree there: browsing project files is
 * not the job on that screen, deciding what the agent gets is.
 *
 * The rich body (four independently collapsible sections with selectable rows)
 * renders as the panel's `customBody`, the same escape hatch the Triggers list
 * uses; the panel keeps ownership of collapse, resize and persistence.
 */
export function AgentResourcesNavigator() {
  const { t } = useLingui();
  const doc = useAgentDocument();

  const descriptor: NavigatorDescriptor = {
    // Its own persistence keys, so collapsing this pane doesn't collapse the
    // assets tree the user returns to.
    id: 'agent-resources',
    // Required: NavigatorPanel hangs the collapse control off `header`.
    header: { title: t`Agent resources` },
    isLoading: doc.isLoading,
    customBody: <AgentResourcesBody doc={doc} />,
  };

  return <NavigatorPanel descriptor={descriptor} />;
}
