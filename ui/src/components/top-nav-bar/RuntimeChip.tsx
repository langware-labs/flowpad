import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown } from 'lucide-react';
import { Project, RuntimeKind } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { WikiButton } from '@src/components/wiki-tip/WikiButton';
import {
  ProjectCountBadge,
  ProjectCountsSummary,
  ProjectListPopoverContent,
  useProjectListMenu,
} from '@src/components/terminal/project-list-menu';
import { cn } from '@src/lib/utils';
import { gfmSlug } from '@src/lib/heading-slug';
import { RUNTIME_APPEARANCE } from './runtime-appearance';

/**
 * The navigation bar's project chip, wearing the runtime's color.
 *
 * Two facts on one pill: WHICH MACHINE serves this UI (the color and the
 * glyph — the safety signal) and WHICH PROJECT you are in (the name). It is a
 * split chip: the project-glyph segment opens the project's home, the name
 * segment opens the shared project list (`project-list-menu`, the same list
 * the advanced tab strip's chip shows). Hovering explains the runtime in a sentence and links
 * to the "Runtime environments" wiki page, peeked in the wiki modal.
 *
 * It DETECTS NOTHING. The kind is resolved by the backend and arrives on
 * `bootstrapInfo.runtime.kind`; this only maps it to a label and a color. An
 * earlier version guessed from `window.location.hostname` and could not tell
 * the Electron shell from a browser tab, nor an agent's box from a user's.
 *
 * The color is a safety signal — on a cloud sandbox or an agent's box it is
 * how you know whose machine you are looking at — which is why it lives in
 * permanent chrome, has no dismiss affordance, and stays on even when the
 * project name replaces the runtime's word. With no project the home segment
 * is gone and the name segment shows that word, so the pill never goes blank.
 */

const WIKI_PAGE = 'Runtime environments';

/** How long the pointer must REST on the name segment before the runtime card
 *  opens. The chip sits on the path to the tab strip and the crumbs, so a
 *  pass-through must not flash the card; the click (the list) is the primary
 *  affordance, the hover is the explanation for someone who lingers. */
export const RUNTIME_HOVER_OPEN_DELAY_MS = 1500;

/** The runtime's glyph at the chip's size. `bg-inherit` on the wrapper and the
 *  badge cut-out so it wears whatever surface it sits on (the pill, or the
 *  hover card's Env chip). */
function RuntimeIcon({ kind, className }: { kind: RuntimeKind; className: string }) {
  const { base, badge } = RUNTIME_APPEARANCE[kind];
  return (
    <IconWithBadge
      Base={base}
      Badge={badge ?? null}
      className={cn('bg-inherit', className)}
      badgeClassName="bg-inherit"
    />
  );
}

/** One pill segment: tinted on hover so it reads as pressable. */
const SEGMENT = 'inline-flex cursor-pointer items-center bg-inherit transition-colors hover:bg-black/20';
/** The raised segment — the project home button — on its own darker surface so
 *  it separates from the runtime tint around it. A black overlay, not a fixed
 *  color, so it stays legible on every tint, light or dark. */
const RAISED_SEGMENT =
  'inline-flex cursor-pointer items-center rounded-full border border-white/30 bg-black/25 transition-colors hover:bg-black/40';
/** One header chip in the hover card. */
const HEADER_CHIP = 'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px]';

function RuntimeLabel({ kind }: { kind: RuntimeKind }) {
  // "Cloud", not "Hub": the chip answers "whose machine am I on", and to a user
  // the hub backend is simply the cloud. "Hub" is our internal word for the
  // component, and it collides with the hub PAGE you can open from a desktop.
  if (kind === RuntimeKind.HUB) return <Trans>Cloud</Trans>;
  if (kind === RuntimeKind.SANDBOX) return <Trans>Cloud Sandbox</Trans>;
  if (kind === RuntimeKind.AGENT) return <Trans>Agent</Trans>;
  if (kind === RuntimeKind.BROWSER) return <Trans>Local Browser</Trans>;
  return <Trans>Desktop</Trans>;
}

/** The hover card's one-line "whose machine is this" sentence, per runtime. */
function RuntimeDescription({ kind }: { kind: RuntimeKind }) {
  if (kind === RuntimeKind.HUB) return <Trans>This UI is served by the Flowpad cloud.</Trans>;
  if (kind === RuntimeKind.SANDBOX) return <Trans>This UI is served by a cloud sandbox you opened.</Trans>;
  if (kind === RuntimeKind.AGENT) return <Trans>This UI is served by an agent's cloud box.</Trans>;
  if (kind === RuntimeKind.BROWSER)
    return <Trans>This UI is served by a local server on your machine, in a browser tab.</Trans>;
  return <Trans>This UI is served by your own desktop.</Trans>;
}

export interface RuntimeChipProps {
  kind: RuntimeKind;
  /** The active project, when there is one. Null shows the runtime's word instead of a name. */
  project?: Project | null;
}

export function RuntimeChip({ kind, project }: RuntimeChipProps) {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const menu = useProjectListMenu({ currentProjectId: project?.id, currentProjectName: project?.displayName });

  const homeLabel = t`Open project home`;
  const { className: runtimeClass, heading } = RUNTIME_APPEARANCE[kind];

  // Per-type icon from the backend TypeInfo registry (CLAUDE.md: never hardcode
  // a glyph for an entity type).
  const ProjectIcon = iconForType(Project.type);

  return (
    // The hover card is left uncontrolled: Radix closes it when the trigger
    // blurs, which opening the list (focus moves into the popover) does.
    <HoverCard openDelay={RUNTIME_HOVER_OPEN_DELAY_MS} closeDelay={100}>
      <Popover open={menu.open} onOpenChange={menu.setOpen}>
        <PopoverAnchor asChild>
          {/* A div, not a button: it holds two controls, and a button inside
              a button is invalid HTML (the nav-bar test pins that). The list
              anchors to the whole pill so it opens under its start edge; the
              hover card hangs off the name segment only, so the home button
              can carry its own plain tooltip. */}
          <div
            data-testid="top-nav-runtime-chip"
            data-runtime={kind}
            className={cn(
              'inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-full text-xs font-semibold',
              runtimeClass,
            )}
          >
            {/* Project home: the project's own glyph, first. Hidden with no
                  project — it addresses one by id, and without it the project
                  page renders "not found". */}
            {project ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => navigation.openDock(DockPointer.forProject(project.id))}
                    data-testid="top-nav-project"
                    aria-label={homeLabel}
                    className={cn(RAISED_SEGMENT, 'my-0.5 ml-0.5 px-2')}
                  >
                    <ProjectIcon className="h-4 w-4 shrink-0" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {homeLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <HoverCardTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="top-nav-project-list"
                  aria-label={t`Open project list`}
                  aria-haspopup="menu"
                  className={cn(SEGMENT, 'gap-1.5 pr-2', project ? 'pl-2' : 'pl-3')}
                >
                  <RuntimeIcon kind={kind} className="h-3.5 w-3.5 shrink-0" />
                  {/* Narrow windows keep the color and drop the word — the color
                      is the signal, the label is the explanation. */}
                  <span className="hidden max-w-[10rem] truncate sm:inline">
                    {menu.projectName ?? <RuntimeLabel kind={kind} />}
                  </span>
                  <ProjectCountBadge menu={menu} hairlineClassName="bg-white/40" iconClassName="opacity-80" />
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-80" />
                </button>
              </PopoverTrigger>
            </HoverCardTrigger>
          </div>
        </PopoverAnchor>
        <HoverCardContent
          side="bottom"
          align="start"
          // pointer-events-auto: the card portals to <body>, which a modal
          // Radix Dialog marks pointer-events:none — keep Learn more clickable.
          className="pointer-events-auto flex w-auto max-w-sm flex-col gap-0.5 px-3 py-2 text-xs"
          data-testid="top-nav-runtime-hover"
        >
          {/* The header names both facts as chips. The Env chip wears the
              runtime color and is the link to that runtime's own section of
              the wiki page; Learn more below opens the page from the top. */}
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {menu.scopeLabel ? (
              <span className={cn(HEADER_CHIP, 'border')} data-testid="top-nav-hover-project">
                <span className="text-muted-foreground">
                  <Trans>Project:</Trans>
                </span>
                <ProjectIcon className="h-3 w-3 shrink-0 text-primary" />
                <span className="max-w-[12rem] truncate font-medium">{menu.scopeLabel}</span>
              </span>
            ) : null}
            <WikiButton
              wikiword={WIKI_PAGE}
              fragment={gfmSlug(heading)}
              className={cn(HEADER_CHIP, 'cursor-pointer hover:opacity-90', runtimeClass)}
              data-testid="top-nav-hover-env"
            >
              <span className="opacity-80">
                <Trans>Env:</Trans>
              </span>
              <RuntimeIcon kind={kind} className="h-3 w-3 shrink-0" />
              <span className="font-medium underline-offset-2 hover:underline">
                <RuntimeLabel kind={kind} />
              </span>
            </WikiButton>
          </div>
          <ProjectCountsSummary menu={menu} />
          <span className="mt-1 border-t pt-1">
            <RuntimeDescription kind={kind} />
          </span>
          <WikiButton wikiword={WIKI_PAGE} linkText={t`Learn more`} className="self-start" />
        </HoverCardContent>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-72 p-1"
          data-testid="top-nav-project-popover"
        >
          <ProjectListPopoverContent menu={menu} />
        </PopoverContent>
      </Popover>
    </HoverCard>
  );
}
