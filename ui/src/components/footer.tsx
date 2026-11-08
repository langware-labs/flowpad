import { LanguageSelector } from '@src/components/footer/LanguageSelector';
import { PendingActionsChip } from '@src/components/footer/PendingActionsChip';
import { LiveSessionsChip } from '@src/components/footer/LiveSessionsChip';
import { ActivityStatusPill } from '@src/components/footer/ActivityStatusPill';
import { usePendingCompletionSound } from '@src/components/footer/usePendingCompletionSound';
import { PoweredBy } from '@src/components/powered-by';
import { IndexerStatusPill } from '@src/components/search-index/IndexerStatusPill';
import { StatusBar } from '@src/components/status-bar';
import { FundingChip } from '@src/components/funding-chip/FundingChip';
import { VersionPopover } from '@src/components/version-popover';
import { HubReleaseLabel } from '@src/components/version-popover/hub-release-label';
import { AdvancedOnly } from '@src/components/view-mode';
import { WarningsPopover } from '@src/components/warnings-popover';
import { SubAgent, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useContext } from '@sdk/react/hooks';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useColorPalette } from '../hooks/useColorPalette';

interface FooterProps {
  className?: string;
}

// Priority-collapse the right-hand cluster on the footer's OWN width (container
// query), not the viewport — viewport breakpoints (md:/lg:) fail to collapse
// when a sidebar/split-pane makes the footer narrower than the window, which is
// how the bar used to overrun. Least-important item yields first: Powered-by.
// (The Help desk button moved into Ask for help's first card.)
// Essentials (version, language, git, pending) never collapse.
// Raw @container + !important (rather than Tailwind variants) because no
// @tailwindcss/container-queries plugin is installed; !important beats the
// utility `.flex` display on the items it hides.
const FOOTER_COLLAPSE_STYLE = /* css */ `
  @container foot (max-width: 960px) { .cq-powered { display: none !important; } }
`;

export function Footer({ className = '' }: FooterProps) {
  const { version } = useContext();
  const { agentId } = useParams();
  const agentTypeId = useMemo(() => (agentId ? new TypeId(SubAgent.type, agentId) : null), [agentId]);
  const { data: agent } = useEntity<SubAgent>(agentTypeId);
  useColorPalette(agent?.site_config);
  usePendingCompletionSound();

  return (
    <footer
      data-testid="footer"
      data-minimize-anchor="footer"
      // container-type establishes this bar as the query container ("foot") the
      // collapse rules above react to.
      style={{ containerType: 'inline-size', containerName: 'foot' }}
      className={`relative z-10 w-full overflow-hidden border-t bg-background/95 px-3 py-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6 ${className}`}
    >
      <style>{FOOTER_COLLAPSE_STYLE}</style>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap sm:justify-between">
        {/* Warnings icon on the left. No mode selector: a mode belongs to a
            session, and its switch lives in that session. */}
        <div className="flex shrink-0 items-center gap-1">
          <WarningsPopover />
        </div>

        {/* Status bar with project name — the single flexible slot that yields
            (its project name truncates) so the bar never overruns. */}
        <StatusBar className="min-w-0 flex-1 sm:ms-4" />

        {/* The activity bar's one-liner: its own item, so it truncates instead of pushing
            the right-hand group over the status bar. Capped at a fifth of the window. */}
        <div className="hidden min-w-0 max-w-[20vw] shrink sm:flex">
          <ActivityStatusPill />
        </div>

        {/* Version + Powered by on the right */}
        <div className="flex w-full min-w-0 items-center justify-end gap-1 overflow-hidden sm:ms-auto sm:w-auto sm:flex-none sm:gap-2">
          {!isHubOnly() && <LiveSessionsChip />}
          <PendingActionsChip />
          <AdvancedOnly reserve={false}>
            <IndexerStatusPill />
          </AdvancedOnly>
          {/* Runtime-shaped, not page-shaped: a desktop showing the hub page still has a desk
              backend, so the popover's actions work there — and the label would
              print the DESK's version under the word "hub". */}
          {isHubOnly() && <HubReleaseLabel hubVersion={version} />}
          {/* Who is paying for the next agent run. Beside the version because it answers the
              same class of question — what am I actually running — and essential for the same
              reason: a wrong funding source spends the wrong money silently. */}
          {!isHubOnly() && <FundingChip />}
          {!isHubOnly() && version && <VersionPopover currentVersion={version} />}
          <PoweredBy className="cq-powered" />
          <LanguageSelector />
        </div>
      </div>
    </footer>
  );
}
