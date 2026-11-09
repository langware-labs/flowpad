import { Trans } from '@lingui/react/macro';
import { agentCounterGroup } from '@src/components/asset-counters/agent-counters';
import { channelCounterGroup } from '@src/components/asset-counters/channel-project-counters';
import {
  hubAgentCounterGroup,
  hubDeploymentCounterGroup,
  hubMachineCounterGroup,
} from '@src/components/asset-counters/hub-counters';
import { hubIssueCounterGroup } from '@src/components/asset-counters/issue-counters';
import { hubSkillCounterGroup, skillCounterGroup } from '@src/components/asset-counters/skill-counters';
import type { AssetCounterGroup } from '@src/components/asset-counters/types';
import type { TabDef } from './ItemsSection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGroup = AssetCounterGroup<any>;

/**
 * The home tabs, written once. Hub and desk list the same kinds with the same words. Shown: Agents, Skills, Issues;
 * Machines, Deployments and Channels are hidden lists an agent card drills into. The only difference is that the desk counts agents and skills within the open project.
 */
const tabs = (agents: AnyGroup, skills: AnyGroup): TabDef[] => [
  {
    group: agents,
    emptyText: <Trans>No agents yet. Make one in 60 seconds and talk to it on Slack, WhatsApp or Telegram.</Trans>,
    createLabel: <Trans>Make an agent</Trans>,
  },
  { group: skills, emptyText: <Trans>No skills yet. A skill teaches your agents one job.</Trans> },
  { group: hubIssueCounterGroup, hideWhenEmpty: true },
  // Opened from an agent card's summary (Agents › <agent> › Machines), never as tabs of their own.
  {
    group: hubMachineCounterGroup,
    hidden: true,
    emptyText: <Trans>No machines yet. A machine runs your agents and workspaces in the cloud.</Trans>,
  },
  {
    group: hubDeploymentCounterGroup,
    hidden: true,
    emptyText: (
      <Trans>
        A deployment puts one of your agents on a channel — Slack, WhatsApp or Telegram — so people can talk to it
        without opening Flowpad.
      </Trans>
    ),
    createLabel: <Trans>Deploy an agent</Trans>,
  },
  {
    group: channelCounterGroup,
    hidden: true,
    emptyText: <Trans>No channels yet. Add a number, bot or app that sends you messages.</Trans>,
  },
];

export const HUB_TABS = tabs(hubAgentCounterGroup, hubSkillCounterGroup);
export const DESK_TABS = tabs(agentCounterGroup, skillCounterGroup);
