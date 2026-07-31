import { Trans, useLingui } from '@lingui/react/macro';
import { ViewToggle } from '@src/components/view-toggle/view-toggle';
import { LanguageSelector } from '@src/components/footer/LanguageSelector';
import { PendingActionsChip } from '@src/components/footer/PendingActionsChip';
import { usePendingCompletionSound } from '@src/components/footer/usePendingCompletionSound';
import { PoweredBy } from '@src/components/powered-by';
import { IndexerStatusPill } from '@src/components/search-index/IndexerStatusPill';
import { StatusBar } from '@src/components/status-bar';
import { VersionPopover } from '@src/components/version-popover';
import { AdvancedOnly, useIsVibe } from '@src/components/view-mode';
import { WarningsPopover } from '@src/components/warnings-popover';
import { PrivacyModePopover } from '@src/components/privacy-mode/privacy-mode-popover';
import { Agent, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { HelpdeskLoadDialog } from '@src/components/helpdesk/HelpdeskLoadDialog';
import { HelpdeskRequestDialog } from '@src/components/helpdesk/HelpdeskRequestDialog';
import { LifeBuoy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useContext } from '@sdk/react/hooks';
import { useColorPalette } from '../hooks/useColorPalette';

interface FooterProps {
  className?: string;
}

// Priority-collapse the right-hand cluster on the footer's OWN width (container
// query), not the viewport — viewport breakpoints (md:/lg:) fail to collapse
// when a sidebar/split-pane makes the footer narrower than the window, which is
// how the bar used to overrun. Least-important items yield first: Powered-by →
// Help Desk label → whole Help Desk button.
// Essentials (version, language, git, pending) never collapse.
// The Help desk button replaced the former Docs + assistance pair, so
// this ladder lost one rung; the surviving thresholds keep their old values.
// Raw @container + !important (rather than Tailwind variants) because no
// @tailwindcss/container-queries plugin is installed; !important beats the
// utility `.flex` display on the items it hides.
const FOOTER_COLLAPSE_STYLE = /* css */ `
  @container foot (max-width: 960px) { .cq-powered { display: none !important; } }
  @container foot (max-width: 860px) { .cq-helpdesk-label { display: none !important; } }
  @container foot (max-width: 520px) { .cq-helpdesk { display: none !important; } }
`;

export function Footer({ className = '' }: FooterProps) {
  const { version } = useContext();
  const { t } = useLingui();
  const { agentId } = useParams();
  const isVibe = useIsVibe();
  const agentTypeId = useMemo(() => (agentId ? new TypeId(Agent.type, agentId) : null), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const [showHelpdesk, setShowHelpdesk] = useState(false);
  const [showAskForHelp, setShowAskForHelp] = useState(false);
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
        {/* View toggle + Data-privacy mode + Warnings icons on the left */}
        <div className="flex shrink-0 items-center gap-1">
          <ViewToggle />
          {!isVibe && <PrivacyModePopover />}
          <WarningsPopover />
        </div>

        {/* Status bar with project name — the single flexible slot that yields
            (its project name truncates) so the bar never overruns. */}
        <StatusBar className="min-w-0 flex-1 sm:ml-4" />

        {/* Version + Powered by on the right */}
        <div className="flex w-full min-w-0 items-center justify-end gap-1 overflow-hidden sm:ml-auto sm:w-auto sm:flex-none sm:gap-2">
          <PendingActionsChip />
          <AdvancedOnly reserve={false}>
            <IndexerStatusPill />
          </AdvancedOnly>
          {/* Single support entry point — replaces the former "Flowpad docs"
              (which opened the bundled assistant project) and the assistance
              entry (which opened the ticket dialog) pair. Opens the
              stepped load flow, which materializes the helpdesk portal
              checkout and then navigates to its project home; the ticket
              dialog now lives on that screen's banner. */}
          <button
            type="button"
            onClick={() => setShowHelpdesk(true)}
            className="cq-helpdesk flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] text-violet-600 transition-colors hover:bg-accent hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
            title={t`Open the help desk`}
            aria-label={t`Help desk`}
            data-testid="footer-helpdesk-button"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            <span className="cq-helpdesk-label"><Trans>Help desk</Trans></span>
          </button>
          {version && <VersionPopover currentVersion={version} />}
          <PoweredBy className="cq-powered" />
          <LanguageSelector />
        </div>
      </div>
      {/* A desk with no portal has nothing to load, so the load dialog hands
          straight over to the ticket flow — which is what the button is for. */}
      <HelpdeskLoadDialog
        open={showHelpdesk}
        onClose={() => setShowHelpdesk(false)}
        onNoPortal={() => {
          setShowHelpdesk(false);
          setShowAskForHelp(true);
        }}
      />
      <HelpdeskRequestDialog open={showAskForHelp} onClose={() => setShowAskForHelp(false)} />
    </footer>
  );
}
