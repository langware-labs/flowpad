import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ArrowLeft, ArrowRight, FolderOpen, Home, PanelsTopLeft, RefreshCw, type LucideIcon } from 'lucide-react';
import { isHomeSurface } from '@src/navigation/dock-layout';
import { tabDock } from '@src/tabs/project-entry';
import { useLastKnownTab } from '@src/tabs/use-tab-manager';
import { tagAttrs } from '@src/tags/tag-attrs';
import { chromeEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useContext } from '@src/hooks/useContext';
import { smartAskOrOpen } from '@src/navigation/smart-ask';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { useHistoryNav } from '@src/navigation/use-history-nav';
import { useDocumentTitle, windowTitleFor } from '@src/navigation/window-title';
import { useOptionalFloatingChat } from '@src/components/floating-chat/FloatingChatContext';
import { AddressAskField } from './AddressAskField';
import { AddressField } from './AddressField';
import { AddressSearchField } from './AddressSearchField';
import { NewChatButton } from './NewChatButton';
import { ProjectSetupButton } from './ProjectSetupButton';
import { RuntimeChip } from './RuntimeChip';
import { TopBarActions } from './TopBarActions';
import { useEntityBreadcrumbs } from './use-entity-breadcrumbs';

/**
 * The app's navigation bar — full window width, above the rail and the content
 * column, mounted once in `FlowPage`.
 *
 * It is a browser navigation bar in the literal sense: history controls, then a
 * chip saying which machine is serving this UI and which project you are in
 * (its name opens the project's home, its chevron the project list), then an
 * address (a breadcrumb of where the current entity lives), then the actions
 * for it.
 *
 * The root is a `div`, not a button: it holds many independent controls, and a
 * button inside a button is invalid HTML that React warns about and screen
 * readers mis-announce. A unit test pins that.
 */
export function TopNavBar() {
  const { t } = useLingui();
  // The address slot's mode: where you are, where you'd rather be, or what you want done.
  const [mode, setMode] = useState<'address' | 'search' | 'ask'>('address');
  const assistant = useOptionalFloatingChat();
  const { currentDock, navigation } = useDockNavigation();
  const { runtimeKind, project } = useContext();
  const { canGoBack, canGoForward, goBack, goForward, reload } = useHistoryNav();
  // Home and Tabs are one button that flips: on the (tabless) home it goes BACK to
  // the last active tab; on any tab it goes home. With no tab open, home is all
  // there is, so it stays Home (disabled on the home itself).
  const atHome = isHomeSurface(currentDock ?? null);
  const lastTabDock = tabDock(useLastKnownTab(atHome));

  // Resolved ONCE per navigation and shared: the address and the actions both
  // need the dock's target, and resolving it twice would double the work on
  // every click.
  const { crumbs, targetTypeId, targetTitle } = useEntityBreadcrumbs(currentDock);
  // The OS window title mirrors the address — same crumbs, no second resolve.
  useDocumentTitle(windowTitleFor(crumbs));

  return (
    <div
      data-testid="top-nav-bar"
      data-runtime={runtimeKind}
      className="flex w-full shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5 py-2"
    >
      {/* Back/forward are the only glyphs in this cluster that encode a
          direction, so they are the only ones that mirror — see `mirrorInRtl`. */}
      <NavIconButton
        icon={ArrowLeft}
        label={t`Back`}
        onClick={goBack}
        disabled={!canGoBack}
        mirrorInRtl
        testId="top-nav-back"
      />
      <NavIconButton
        icon={ArrowRight}
        label={t`Forward`}
        onClick={goForward}
        disabled={!canGoForward}
        mirrorInRtl
        testId="top-nav-forward"
      />
      {/* A full window reload, the same as the browser's own — no modifier
          gesture and no soft variant. Anything less does not reload. */}
      <NavIconButton icon={RefreshCw} label={t`Reload`} onClick={reload} testId="top-nav-reload" />
      {lastTabDock ? (
        <NavIconButton
          icon={PanelsTopLeft}
          label={t`Back to tabs`}
          onClick={() => navigation.openDock(lastTabDock, undefined, { topLevel: true })}
          testId="top-nav-tabs"
          tag="TopNavTabs"
        />
      ) : (
        <NavIconButton
          icon={Home}
          label={t`Home`}
          onClick={() => navigation.goHome({ homePage: true })}
          disabled={atHome}
          testId="top-nav-home"
        />
      )}
      {/* Files sat on the rail; same destination, same one-liner, just beside
          the other place-buttons instead of below them. */}
      <NavIconButton
        icon={FolderOpen}
        label={t`Files`}
        onClick={() => navigation.openTab(ViewType.EXPLORER)}
        testId="top-nav-files"
      />
      <RuntimeChip kind={runtimeKind} project={project} />
      <ProjectSetupButton project={project} />
      {/* One slot, three modes — the address is where you are, search is
          where you'd rather be, and ask (a click on the pill's dead space) is
          what you want done, handed to the Flowpad Assistant. Same pill, same
          width, so the row doesn't reflow when it flips; the magnifier that flips it sits on the pill's
          right edge, which is also where the rail's search used to live. */}
      {mode === 'search' ? (
        <AddressSearchField onClose={() => setMode('address')} />
      ) : mode === 'ask' && assistant ? (
        <AddressAskField
          onAsk={(text, rect) =>
            // A plain "open X" opens X with no assistant turn when the hub has a decision API;
            // anything else -- or no decision API at all -- is today's ask, unchanged. Signed
            // out, the session's first request asks whether to sign in first (smart-ask.ts).
            void smartAskOrOpen(text, {
              open: (dock) => navigation.openDock(dock),
              ask: (prompt) =>
                assistant.ask(prompt, {
                  rect: rect && { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                }),
            })
          }
          onClose={() => setMode('address')}
        />
      ) : (
        <AddressField
          crumbs={crumbs}
          onSearch={() => setMode('search')}
          onAsk={assistant ? () => setMode('ask') : undefined}
        />
      )}
      <TopBarActions targetTypeId={targetTypeId} targetTitle={targetTitle} dock={currentDock} />
      {/* Quick launch, last in the row: unlike the actions beside it, it acts
          on nothing the bar is addressing — it starts somewhere new. One click,
          no picker; the harness is the last one used and the mode is the
          current one. */}
      <NewChatButton />
    </div>
  );
}

/** Wears `chromeEntityActionClassName` — the shared entity-action contract at
 *  its window-chrome size — so the bar reads as one row of controls and the
 *  size lives in the style module rather than in each call site. */
function NavIconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  mirrorInRtl = false,
  testId,
  tag,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Mirror the glyph in RTL. For an arrow that means a DIRECTION rather than a
   *  fixed shape: "back" points against the reading flow, so it faces left in
   *  English and right in Hebrew. A house or a folder is the same shape in every
   *  language and must NOT be flipped. */
  mirrorInRtl?: boolean;
  testId: string;
  /** Observable/highlightable tag word (journeys target it). */
  tag?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The span keeps the tooltip reachable while the button is disabled —
            a disabled button fires no pointer events of its own. */}
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={chromeEntityActionClassName}
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            data-testid={testId}
            {...(tag ? tagAttrs(tag, 'button') : {})}
          >
            <Icon className={cn(mirrorInRtl && 'rtl:-scale-x-100')} />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
