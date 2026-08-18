import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbChevron,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@src/components/ui/breadcrumb';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ADDRESS_PILL_CLASS } from './address-pill';
import { CrumbDetailsPopover } from './CrumbDetailsPopover';
import { ProjectCrumbHoverCard } from './ProjectCrumbHoverCard';
import { selectVisibleCrumbs } from './crumb-overflow';
import type { Crumb } from './use-entity-breadcrumbs';

/**
 * The address bar: `Project / …ancestors… / current`.
 *
 * Navigation stays URL-first. A crumb click calls `openDock` and NOTHING else —
 * no context writes, no optimistic state. The crumb list is re-derived from the
 * new URL on the next render, which is also why nothing here tracks an "active"
 * crumb of its own.
 *
 * Crumbs navigate to what they name — except the project, which opens the
 * projects list (the same `OpenProjectComponent` the footer's "Switch Project"
 * uses). That is what the project chip this replaced did, and "which project am
 * I in" is the more useful question from an address bar; the briefcase button in
 * the nav cluster opens the project itself.
 */
export function AddressField({ crumbs, onSearch }: { crumbs: Crumb[]; onSearch: () => void }) {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const [projectModalOpen, setProjectModalOpen] = useState(false);

  const fieldRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [available, setAvailable] = useState(0);
  const [widths, setWidths] = useState<number[]>([]);

  // One observer on the field, not a window listener: the bar's width changes
  // with the window AND with anything that resizes its neighbours.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    setAvailable(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Measure the crumbs as laid out. jsdom reports 0 for everything, which
  // `selectVisibleCrumbs` detects and answers with its count rule.
  useLayoutEffect(() => {
    const items = listRef.current?.querySelectorAll('[data-crumb]');
    if (!items) return;
    const next = Array.from(items, (el) => (el as HTMLElement).offsetWidth);
    // Bail out when nothing actually moved. A fresh array would re-render on
    // every observer tick — ~60/s while a window edge is being dragged — each
    // one preceded by the forced layout these reads cause.
    setWidths((prev) => (prev.length === next.length && prev.every((w, i) => w === next[i]) ? prev : next));
  }, [crumbs, available]);

  const { visible, hidden } = selectVisibleCrumbs(crumbs, widths, available);

  const go = (crumb: Crumb) => {
    if (crumb.kind === 'project') {
      setProjectModalOpen(true);
      return;
    }
    if (crumb.pointer) navigation.openDock(crumb.pointer);
  };

  const renderCrumb = (crumb: Crumb, isLast: boolean) => {
    const Icon = crumb.Icon;
    const body = (
      <>
        {/* Sized as a control, not as decoration: these glyphs are slated to
            become buttons of their own, so they carry a button's target size
            already and only the click handler is missing. */}
        <Icon className="h-4 w-4 shrink-0 opacity-70" />
        <span className="truncate">{crumb.label}</span>
      </>
    );
    // The current page is not a link, and neither is an ancestor of a type no
    // dock can address — a dead link is worse than plain text.
    const navigable = crumb.kind === 'project' || !!crumb.pointer;
    // The current crumb of a FILE-backed dock opens its details instead: the
    // real filename, the path, and the two ways to go find it. That is where the
    // asset editor's header row went.
    const page = <BreadcrumbPage className="flex min-w-0 items-center gap-1 font-normal">{body}</BreadcrumbPage>;
    return (
      <BreadcrumbItem key={crumb.key} data-crumb className={isLast ? 'min-w-0 shrink' : 'shrink-0'}>
        {crumb.kind === 'project' ? (
          <ProjectCrumbHoverCard>
            <BreadcrumbLink
              className="flex cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() => go(crumb)}
            >
              {body}
            </BreadcrumbLink>
          </ProjectCrumbHoverCard>
        ) : isLast && crumb.path ? (
          <CrumbDetailsPopover label={crumb.label} filename={crumb.filename} path={crumb.path}>
            <button
              type="button"
              data-testid="top-nav-crumb-details-trigger"
              title={crumb.filename || crumb.label}
              className="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm hover:text-foreground"
            >
              {body}
            </button>
          </CrumbDetailsPopover>
        ) : isLast || !navigable ? (
          page
        ) : (
          <BreadcrumbLink
            className="flex cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() => go(crumb)}
            title={crumb.label}
          >
            {body}
          </BreadcrumbLink>
        )}
      </BreadcrumbItem>
    );
  };

  return (
    <>
      <div ref={fieldRef} data-testid="top-nav-address" className={ADDRESS_PILL_CLASS}>
        <Breadcrumb className="min-w-0">
          <BreadcrumbList ref={listRef} className="flex-nowrap gap-1.5 text-sm sm:gap-1.5">
            {visible.map((crumb, i) => {
              const isLast = i === visible.length - 1;
              const showEllipsis = i === 0 && hidden.length > 0;
              return (
                <React.Fragment key={crumb.key}>
                  {renderCrumb(crumb, isLast)}
                  {!isLast && (
                    <BreadcrumbSeparator className="shrink-0">
                      <BreadcrumbChevron className="h-3.5 w-3.5" />
                    </BreadcrumbSeparator>
                  )}
                  {showEllipsis && (
                    <>
                      <BreadcrumbItem className="shrink-0">
                        <Popover>
                          {/* BreadcrumbEllipsis is aria-hidden presentation, so
                              it needs a real button around it to be reachable. */}
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              data-testid="top-nav-crumb-overflow"
                              aria-label={t`Show hidden path segments`}
                              className="flex cursor-pointer items-center rounded-sm hover:text-foreground"
                            >
                              <BreadcrumbEllipsis className="h-5 w-5" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align="start" className="w-64 p-1">
                            {hidden.map((h) => {
                              const HIcon = h.Icon;
                              return (
                                <button
                                  key={h.key}
                                  type="button"
                                  disabled={!h.pointer}
                                  onClick={() => go(h)}
                                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm hover:bg-accent disabled:cursor-default disabled:opacity-60"
                                >
                                  <HIcon className="h-4 w-4 shrink-0 opacity-70" />
                                  <span className="truncate">{h.label}</span>
                                </button>
                              );
                            })}
                          </PopoverContent>
                        </Popover>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator className="shrink-0">
                        <BreadcrumbChevron className="h-3.5 w-3.5" />
                      </BreadcrumbSeparator>
                    </>
                  )}
                </React.Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
        {/* Search lives INSIDE the field, pinned to its trailing edge — the pill
            is the thing that becomes the query box, so the control that turns
            it into one belongs in it. `ms-auto` (margin-INLINE-start) keeps it
            on that edge however short the crumb trail is, and follows the
            reading direction: the right edge in English, the left edge in
            Hebrew. The physical `ms-auto` it replaced parked the magnifier in
            the middle of an RTL bar. */}
        <button
          type="button"
          onClick={onSearch}
          aria-label={t`Search`}
          title={t`Search`}
          data-testid="top-nav-search-open"
          className="ms-auto flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Search className="h-4 w-4" />
        </button>
      </div>
      {/* Mounted only while open. The dialog renders its body regardless of
          `open`, and that body subscribes to the all-tabs store and warms
          project entities — work this bar would otherwise do on every route,
          for a dialog nobody has asked for yet. */}
      {projectModalOpen && <OpenProjectComponent open onOpenChange={setProjectModalOpen} />}
    </>
  );
}
