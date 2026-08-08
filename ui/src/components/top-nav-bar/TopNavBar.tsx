import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ArrowLeft, ArrowRight, FolderOpen, Home, RefreshCw, type LucideIcon } from 'lucide-react';
import { chromeEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useContext } from '@src/hooks/useContext';
import { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { useHistoryNav } from '@src/navigation/use-history-nav';
import { AddressField } from './AddressField';
import { AddressSearchField } from './AddressSearchField';
import { RuntimeChip } from './RuntimeChip';
import { TopBarActions } from './TopBarActions';
import { useEntityBreadcrumbs } from './use-entity-breadcrumbs';

/**
 * The app's navigation bar — full window width, above the rail and the content
 * column, mounted once in `FlowPage`.
 *
 * It is a browser navigation bar in the literal sense: history controls, then a
 * chip saying which machine is serving this UI, then an address (a breadcrumb
 * of where the current entity lives), then the actions for it.
 *
 * The root is a `div`, not a button: it holds many independent controls, and a
 * button inside a button is invalid HTML that React warns about and screen
 * readers mis-announce. A unit test pins that.
 */
export function TopNavBar() {
  const { t } = useLingui();
  const [searching, setSearching] = useState(false);
  const { currentDock, navigation } = useDockNavigation();
  const { runtimeKind, project } = useContext();
  const { canGoBack, canGoForward, goBack, goForward, reload, hardReload, reloading } = useHistoryNav();

  // Resolved ONCE per navigation and shared: the address and the actions both
  // need the dock's target, and resolving it twice would double the work on
  // every click.
  const { crumbs, targetTypeId, targetTitle } = useEntityBreadcrumbs(currentDock);

  return (
    <div
      data-testid="top-nav-bar"
      data-runtime={runtimeKind}
      className="flex w-full shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5 py-2"
    >
      <NavIconButton icon={ArrowLeft} label={t`Back`} onClick={goBack} disabled={!canGoBack} testId="top-nav-back" />
      <NavIconButton
        icon={ArrowRight}
        label={t`Forward`}
        onClick={goForward}
        disabled={!canGoForward}
        testId="top-nav-forward"
      />
      <NavIconButton
        icon={RefreshCw}
        label={t`Reload`}
        // Soft by default — re-runs the route loaders. A modifier click gives
        // the browser's hard-reload gesture, for when the runtime itself is
        // wedged rather than the data being stale.
        onClick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? hardReload() : reload())}
        spinning={reloading}
        testId="top-nav-reload"
      />
      <NavIconButton icon={Home} label={t`Home`} onClick={() => navigation.goHome()} testId="top-nav-home" />
      {/* Files sat on the rail; same destination, same one-liner, just beside
          the other place-buttons instead of below them. */}
      <NavIconButton
        icon={FolderOpen}
        label={t`Files`}
        onClick={() => navigation.openTab(ViewType.EXPLORER)}
        testId="top-nav-files"
      />
      {/* The project itself — the destination the old rail briefcase and the
          footer's project name both led to. Its glyph comes from the type
          registry, never a literal, so a TypeInfo change reaches it too. Hidden
          with no project: it addresses one by id, and without it the project
          page renders "not found". */}
      {project && (
        <NavIconButton
          icon={iconForType(Project.type)}
          label={t`Project home`}
          onClick={() => navigation.openDock(DockPointer.forProject(project.id))}
          testId="top-nav-project"
        />
      )}

      <RuntimeChip kind={runtimeKind} />
      {/* One slot, two modes — the address is where you are, and search is
          where you'd rather be. Same pill, same width, so the row doesn't
          reflow when it flips; the magnifier that flips it sits on the pill's
          right edge, which is also where the rail's search used to live. */}
      {searching ? (
        <AddressSearchField onClose={() => setSearching(false)} />
      ) : (
        <AddressField crumbs={crumbs} onSearch={() => setSearching(true)} />
      )}
      <TopBarActions targetTypeId={targetTypeId} targetTitle={targetTitle} dock={currentDock} />
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
  spinning = false,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  spinning?: boolean;
  testId: string;
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
          >
            <Icon className={spinning ? 'animate-spin' : undefined} />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
