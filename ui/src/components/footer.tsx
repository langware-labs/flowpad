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
import { Agent, FLOWPAD_ASSISTANT_PROJECT_UNAME, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { CommunityAssistanceDialog } from '@src/components/community-assistance-dialog/CommunityAssistanceDialog';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { BookOpen, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useContext } from '@sdk/react/hooks';
import { useColorPalette } from '../hooks/useColorPalette';

interface FooterProps {
  className?: string;
}

export function Footer({ className = '' }: FooterProps) {
  const { version } = useContext();
  const { t } = useLingui();
  const { agentId } = useParams();
  const isVibe = useIsVibe();
  const agentTypeId = useMemo(() => (agentId ? new TypeId(Agent.type, agentId) : null), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const { navigation } = useDockNavigation();
  const [showCommunityAssistance, setShowCommunityAssistance] = useState(false);
  useColorPalette(agent?.site_config);
  usePendingCompletionSound();

  return (
    <footer
      data-testid="footer"
      data-minimize-anchor="footer"
      className={`relative z-10 w-full overflow-hidden border-t bg-background/95 px-3 py-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6 ${className}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap sm:justify-between">
        {/* View toggle + Data-privacy mode + Warnings icons on the left */}
        <div className="flex shrink-0 items-center gap-1">
          <ViewToggle />
          {!isVibe && <PrivacyModePopover />}
          <WarningsPopover />
        </div>

        {/* Status bar with project name */}
        <StatusBar className="min-w-0 flex-1 sm:ml-4" />

        <div className="hidden min-w-0 flex-1 md:block" />

        {/* Version + Powered by on the right */}
        <div className="flex w-full min-w-0 items-center justify-end gap-1 overflow-hidden sm:ml-auto sm:w-auto sm:flex-none sm:gap-2">
          <PendingActionsChip />
          <AdvancedOnly reserve={false}>
            <IndexerStatusPill />
          </AdvancedOnly>
          <button
            type="button"
            onClick={() => navigation.openDock(DockPointer.forProject(`@${FLOWPAD_ASSISTANT_PROJECT_UNAME}`))}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t`Open Flowpad docs`}
            aria-label={t`Flowpad docs`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span className="hidden md:inline"><Trans>Flowpad docs</Trans></span>
          </button>
          <button
            type="button"
            onClick={() => setShowCommunityAssistance(true)}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] text-violet-600 transition-colors hover:bg-accent hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
            title={t`Community assistance`}
            aria-label={t`Community assistance`}
          >
            <Users className="h-3.5 w-3.5" />
            <span className="hidden lg:inline"><Trans>Community assistance</Trans></span>
          </button>
          {version && <VersionPopover currentVersion={version} />}
          <PoweredBy className="hidden lg:flex" />
          <LanguageSelector />
        </div>
      </div>
      <CommunityAssistanceDialog
        open={showCommunityAssistance}
        onClose={() => setShowCommunityAssistance(false)}
      />
    </footer>
  );
}
