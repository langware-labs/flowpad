import { Trans, useLingui } from '@lingui/react/macro';
import { Bot, ChevronDown, CloudUpload, Globe, Monitor, type LucideIcon } from 'lucide-react';
import { Project, RuntimeKind } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { WikiButton } from '@src/components/wiki-tip/WikiButton';
import {
  ProjectListPopoverContent,
  ProjectScopeSummary,
  useProjectListMenu,
} from '@src/components/terminal/project-list-menu';
import { RUNTIME_CLASS } from './runtime-appearance';

/**
 * The navigation bar's project chip, wearing the runtime's color.
 *
 * Two facts on one pill: WHICH MACHINE serves this UI (the color and the
 * glyph — the safety signal) and WHICH PROJECT you are in (the name). It is a
 * split chip: the name segment opens the project's home, the chevron opens the
 * shared project list (`project-list-menu`, the same list the advanced tab
 * strip's chip shows). Hovering explains the runtime in a sentence and links
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
 * project name replaces the runtime's word. With no project the name segment
 * falls back to that word, so the pill never goes blank.
 */

const WIKI_PAGE = 'Runtime environments';

/** Per-runtime glyphs. These describe RUNTIMES, not entity types — there is no
 *  TypeInfo for "a cloud sandbox", so `iconForType` has nothing to resolve.
 *  The cloud kinds wear the same glyph as the "Link to cloud" buttons. */
const RUNTIME_ICON: Record<RuntimeKind, LucideIcon> = {
  [RuntimeKind.HUB]: CloudUpload,
  [RuntimeKind.SANDBOX]: CloudUpload,
  [RuntimeKind.AGENT]: Bot,
  [RuntimeKind.DESKTOP]: Monitor,
  [RuntimeKind.BROWSER]: Globe,
};

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

  const listLabel = t`Open project list`;
  const homeLabel = project ? t`Project home` : listLabel;

  // URL-first (CLAUDE.md): the name segment only navigates. Without a project
  // there is no home to address, so the segment opens the list instead — a
  // dead segment would be worse than a second way into the same menu.
  const openHome = () => {
    if (project) navigation.openDock(DockPointer.forProject(project.id));
    else menu.setOpen(true);
  };

  const Icon = RUNTIME_ICON[kind] ?? Monitor;

  return (
    // The hover card is left uncontrolled: Radix closes it when the trigger
    // blurs, which opening the list (focus moves into the popover) does.
    <HoverCard openDelay={200} closeDelay={100}>
      <Popover open={menu.open} onOpenChange={menu.setOpen}>
        <HoverCardTrigger asChild>
          <PopoverAnchor asChild>
            {/* A div, not a button: it holds two controls, and a button inside
                a button is invalid HTML (the nav-bar test pins that). The list
                anchors to the whole pill so it opens under its start edge. */}
            <div
              data-testid="top-nav-runtime-chip"
              data-runtime={kind}
              className={`inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-full text-xs font-semibold ${RUNTIME_CLASS[kind]}`}
            >
              <button
                type="button"
                onClick={openHome}
                data-testid="top-nav-project"
                aria-label={homeLabel}
                className="inline-flex cursor-pointer items-center gap-1.5 pl-3 pr-2 hover:opacity-90"
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {/* Narrow windows keep the color and drop the word — the color
                    is the signal, the label is the explanation. */}
                <span className="hidden max-w-[10rem] truncate sm:inline">
                  {menu.projectName ?? <RuntimeLabel kind={kind} />}
                </span>
              </button>
              <span aria-hidden className="my-1.5 w-px bg-current opacity-40" />
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="top-nav-project-list"
                  aria-label={listLabel}
                  aria-haspopup="menu"
                  className="inline-flex cursor-pointer items-center pl-1.5 pr-2 hover:opacity-90"
                >
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </button>
              </PopoverTrigger>
            </div>
          </PopoverAnchor>
        </HoverCardTrigger>
        <HoverCardContent
          side="bottom"
          align="start"
          // pointer-events-auto: the card portals to <body>, which a modal
          // Radix Dialog marks pointer-events:none — keep Learn more clickable.
          className="pointer-events-auto flex w-auto max-w-sm flex-col gap-0.5 px-3 py-2 text-xs"
          data-testid="top-nav-runtime-hover"
        >
          <ProjectScopeSummary menu={menu} />
          <span className="mt-1 border-t pt-1">
            <RuntimeDescription kind={kind} />
          </span>
          <WikiButton wikiword={WIKI_PAGE} linkText={t`Learn more`} className="self-start" />
        </HoverCardContent>
        <PopoverContent align="start" side="bottom" sideOffset={6} className="w-72 p-1" data-testid="top-nav-project-popover">
          <ProjectListPopoverContent menu={menu} />
        </PopoverContent>
      </Popover>
    </HoverCard>
  );
}
