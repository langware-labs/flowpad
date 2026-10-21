import { Trans } from '@lingui/react/macro';
import { AssetSummaryChip, CounterChip } from '@src/components/asset-counters/AssetCounterRow';
import {
  hubAgentCounterGroup,
  hubDeploymentCounterGroup,
  hubMachineCounterGroup,
} from '@src/components/asset-counters/hub-counters';
import { openInbound } from '@src/components/inbound/inbound-pointer';
import { useInboundClaims } from '@src/components/inbound/use-inbound';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { InboundWebhooks, PageId, ViewType } from '@sdk';

/** Inbound has its own screen, so its chip opens that rather than an asset table. Read once — no polling here. */
function InboundChip() {
  const { navigation } = useDockNavigation();
  const { numbers, loading } = useInboundClaims(InboundWebhooks, 0);
  return (
    <CounterChip
      count={numbers.length}
      label={<Trans>Channels</Trans>}
      isLoading={loading}
      onClick={() => openInbound(navigation)}
      testId="summary-chip-inbound"
    />
  );
}

/** The hub home's one-line summary: what the caller has, each chip opening its list. */
export function HubSummaryLine() {
  const { navigation } = useDockNavigation();
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2.5 [&_button]:gap-2 [&_button]:px-4 [&_button]:py-1.5 [&_button]:text-sm"
      data-testid="hub-summary-line"
    >
      <AssetSummaryChip group={hubAgentCounterGroup} />
      <AssetSummaryChip
        group={hubMachineCounterGroup}
        onClick={() => navigation.openPage(PageId.HUB, ViewType.MACHINES)}
      />
      <AssetSummaryChip group={hubDeploymentCounterGroup} />
      <InboundChip />
    </div>
  );
}
