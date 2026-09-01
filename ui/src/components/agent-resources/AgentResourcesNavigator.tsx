import { useLingui } from '@lingui/react/macro';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { AgentResourcesBody } from './AgentResourcesBody';

/**
 * Zone B while an agent is edited: what the agent can draw on, not a file tree.
 * Renders as the panel's `customBody`, so collapse/resize stay with the panel.
 */
export function AgentResourcesNavigator() {
  const { t } = useLingui();

  const descriptor: NavigatorDescriptor = {
    // Its own persistence keys, so collapsing this pane doesn't collapse the
    // assets tree the user returns to.
    id: 'agent-resources',
    // Required: NavigatorPanel hangs the collapse control off `header`.
    header: { title: t`Agent resources` },
    customBody: <AgentResourcesBody />,
  };

  return <NavigatorPanel descriptor={descriptor} />;
}
