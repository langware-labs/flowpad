import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ArrowLeftRight, ChevronRight } from 'lucide-react';
import {
  Breadcrumb,
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
 * Every crumb navigates to what it names, the project included. CHANGING
 * project is a different verb, so it gets its own control beside that crumb —
 * the same `OpenProjectComponent` the footer's "Switch Project" button opens.
 */
export function AddressField({ crumbs }: { crumbs: Crumb[] }) {
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
    if (crumb.pointer) navigation.openDock(crumb.pointer);
  };

  const renderCrumb = (crumb: Crumb, isLast: boolean) => {
    const Icon = crumb.Icon;
    const body = (
      <>
        <Icon className="h-3 w-3 shrink-0 opacity-70" />
        <span className="truncate">{crumb.label}</span>
      </>
    );
    // The current page is not a link, and neither is an ancestor of a type no
    // dock can address — a dead link is worse than plain text.
    const navigable = !!crumb.pointer;
    return (
      <BreadcrumbItem key={crumb.key} data-crumb className={isLast ? 'min-w-0 shrink' : 'shrink-0'}>
        {isLast || !navigable ? (
          <BreadcrumbPage className="flex min-w-0 items-center gap-1 font-normal">{body}</BreadcrumbPage>
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
      <div
        ref={fieldRef}
        data-testid="top-nav-address"
        className="flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded-full border bg-background px-2.5 text-xs text-muted-foreground"
      >
        <Breadcrumb className="min-w-0">
          <BreadcrumbList ref={listRef} className="flex-nowrap gap-1 text-xs sm:gap-1">
            {visible.map((crumb, i) => {
              const isLast = i === visible.length - 1;
              const showEllipsis = i === 0 && hidden.length > 0;
              return (
                <React.Fragment key={crumb.key}>
                  {renderCrumb(crumb, isLast)}
                  {/* Switching projects is a different verb from opening the
                      one you're in, so it gets its own control rather than
                      stealing the crumb's click. Same dialog the footer's
                      "Switch Project" opens. */}
                  {crumb.kind === 'project' && (
                    <button
                      type="button"
                      onClick={() => setProjectModalOpen(true)}
                      data-testid="top-nav-project-select"
                      aria-label={t`Select a different project`}
                      title={t`Select a different project`}
                      className="flex h-5 shrink-0 cursor-pointer items-center rounded-sm px-0.5 hover:bg-accent hover:text-foreground"
                    >
                      <ArrowLeftRight className="h-3 w-3" />
                    </button>
                  )}
                  {!isLast && (
                    <BreadcrumbSeparator className="shrink-0">
                      <ChevronRight className="h-3 w-3" />
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
                              <BreadcrumbEllipsis className="h-4 w-4" />
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
                                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-default disabled:opacity-60"
                                >
                                  <HIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                                  <span className="truncate">{h.label}</span>
                                </button>
                              );
                            })}
                          </PopoverContent>
                        </Popover>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator className="shrink-0">
                        <ChevronRight className="h-3 w-3" />
                      </BreadcrumbSeparator>
                    </>
                  )}
                </React.Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {/* Mounted only while open. The dialog renders its body regardless of
          `open`, and that body subscribes to the all-tabs store and warms
          project entities — work this bar would otherwise do on every route,
          for a dialog nobody has asked for yet. */}
      {projectModalOpen && <OpenProjectComponent open onOpenChange={setProjectModalOpen} />}
    </>
  );
}
