import { useLingui } from '@lingui/react/macro';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { AgentResourcesBody } from './AgentResourcesBody';

/**
 * Agent-resources left-menu — the navigator (Zone B) while an agent is being
 * created or edited. Replaces the assets tree there: browsing project files is
 * not the job on that screen, seeing what the agent can draw on is.
 *
 * The rich body (four independently collapsible sections) renders as the
 * panel's `customBody`, the same escape hatch the Triggers list uses; the panel
 * keeps ownership of collapse, resize and persistence.
 *
 * No agent is resolved here. Every section lists resources that are available
 * at global or context scope rather than per-agent state, so the pane reads
 * nothing off the edited `agent.md` — each section owns its own query and its
 * own loading state.
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
