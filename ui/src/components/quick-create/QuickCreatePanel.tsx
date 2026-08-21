import { Trans, useLingui } from '@lingui/react/macro';
import { useProject } from '@sdk/react/hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { BindSecretDialog } from '@src/components/project-home/BindSecretDialog';
import {
  CONTEXT_FOLDERS_WIKI,
  ContextFolderScopeChips,
  useContextFolderSources,
  type ContextFolderSource,
} from '@src/components/assets/context-folder-sources';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';
import LoginDialog, { ActionType } from '@src/components/login-required-dialog';
import { useLoginRequired, useResumeAfterLogin } from '@src/hooks/use-login-required';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useAddContextFolder } from '@src/hooks/use-add-context-folder';
import type { ContextFolderScope } from '@src/hooks/use-project-context-folders';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { tagAttrs } from '@src/tags/tag-attrs';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openNewChat } from '@src/navigation/open-new-chat';
import { openCapabilitiesForWorker } from '@src/navigation/open-capabilities';
import { Info, KeyRound, Loader2, MessageSquarePlus } from 'lucide-react';
import {
  Fragment,
  forwardRef,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from 'react';
import { WikiButton, WikiTip } from '@src/components/wiki-tip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { QuickCreateDialog } from './QuickCreateDialog';
import { QUICK_CREATE_REGISTRY, getDescriptor } from './registry';
import { providerMetaFor } from '@src/tabs/provider-meta';

/** Registry types deliberately absent from this launcher (still creatable from
 *  the Assets page's per-type "+"). */
const HIDDEN_ASSET_TYPES = new Set(['dynamic_workflow']);

/** Wiki pages behind the non-registry tiles — hoisted so each title is written
 *  once (a wikiword resolves by page title at runtime, so a typo degrades into
 *  a "create this page" prompt rather than an error). Registry types carry
 *  their own `wikiword`; the folder sources carry theirs. */
const CLAUDE_CODE_WIKI = 'Claude Code sessions';
const CODEX_WIKI = 'Codex sessions';
const COPILOT_WIKI = 'Copilot sessions';
const OPENCODE_WIKI = 'OpenCode sessions';
const SECRET_WIKI = 'Project secrets';
const CONVERSATION_WIKI = 'Conversations';

/** A dense grid — a card under every tile the pointer crosses is noise. */
const TILE_TIP_DELAY = 500;

/** Icon components accept a className — both lucide icons and the brand SVGs. */
type TileIcon = ComponentType<{ className?: string }>;

export type DesktopTileProps = {
  /** The type/action glyph. Optional only because `iconSlot` can stand in for
   *  it; pass exactly one. */
  Icon?: TileIcon;
  label: string;
  /** A ready-made face to draw INSTEAD of `Icon` — for a tile whose glyph is
   *  bound to one entity rather than to a type (an agent's avatar). An inline
   *  `Icon={(p) => <Avatar …/>}` adapter would have a new component identity on
   *  every render and remount its `<img>` each time; a node does not. `loading`
   *  still wins over both. */
  iconSlot?: ReactNode;
  iconClassName?: string;
  disabled?: boolean;
  /** In-flight: show a spinner instead of `Icon` and refuse clicks. Lives here
   *  rather than in each caller so every tile spells "working" the same way. */
  loading?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>;

/**
 * The square icon-over-label tile every "New …" affordance on project home
 * uses — sized to match the home MiniDesktop / favorites grid. Exported so
 * sibling surfaces (hub home's projects and desktops) present the same shape
 * rather than inventing a second look for the same kind of act.
 *
 * Forwards its ref and spreads the rest of its props onto the real `<button>`
 * so it can be a Radix `asChild` trigger: `Slot` clones this element to merge
 * the ref plus the hover/focus handlers a `WikiTip` hangs off it. Swallow those
 * and the tip silently never opens.
 *
 * `disabled` is expressed as `aria-disabled`, not the native attribute — a
 * natively disabled button drops pointer events, which would take its WikiTip
 * with it, and an unavailable tile is exactly the one worth explaining.
 */
export const DesktopTile = forwardRef<HTMLButtonElement, DesktopTileProps>(function DesktopTile(
  { Icon, iconSlot, label, iconClassName, disabled, loading, className, onClick, ...rest },
  ref,
) {
  const inert = disabled || loading;
  return (
    <button
      ref={ref}
      type="button"
      onClick={inert ? undefined : onClick}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      aria-label={label}
      className={cn(
        'flex h-20 w-20 flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-background text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        inert
          ? 'cursor-not-allowed opacity-50'
          : 'cursor-pointer hover:border-primary hover:bg-accent hover:text-foreground',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className={cn('h-7 w-7 animate-spin', iconClassName)} />
      ) : (
        // `iconSlot` owns its own sizing — `iconClassName` is the Icon's.
        (iconSlot ?? (Icon ? <Icon className={cn('h-7 w-7', iconClassName)} /> : null))
      )}
      {/* Two lines, not one truncated one: a multi-word label ("Folder on this
          computer") is unreadable clipped, and two 10px lines still clear the
          tile's height. */}
      <span className="line-clamp-2 w-full text-balance break-words px-1 text-center text-[10px] font-medium leading-tight">
        {label}
      </span>
    </button>
  );
});

/** One labelled group of tiles. `headerExtra` sits beside the heading, for a
 *  control that scopes the whole group (the folder sources' private/shared).
 *  Exported so sibling home sections (the harness launcher) share one heading
 *  style rather than re-deriving it. */
export function TileSection({
  title,
  headerExtra,
  children,
}: {
  title: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {headerExtra}
      </div>
      <div className="flex flex-wrap gap-3">{children}</div>
    </section>
  );
}

/**
 * A DesktopTile with its wiki page one hover away. Every tile on this surface
 * is tipped: the grid is often a new user's first sight of these concepts, and
 * a 10px label can't explain what a skill or a context folder is.
 */
function TippedTile({ wikiword, tip, ...tile }: { wikiword: string; tip?: string } & DesktopTileProps) {
  const { t } = useLingui();
  return (
    <WikiTip
      wikiword={wikiword}
      label={tip ?? tile.label}
      buttonLabel={t`What is ${tile.label}?`}
      openDelay={TILE_TIP_DELAY}
    >
      {/* Every tile is a tag (its wikiword): highlightable by journeys and
          click-observable on the EventBus, with no per-tile wiring. */}
      <DesktopTile {...tagAttrs(wikiword, 'button')} {...tile} />
    </WikiTip>
  );
}

/**
 * useQuickCreatePick — hosts every dialog a QuickCreatePanel tile opens.
 *
 * The dialogs are deliberately the *host's* to render, not the panel's: the
 * modal host closes on pick, which unmounts the panel — and would take any
 * dialog the panel owned straight down with it, so the tile would appear to do
 * nothing. Spread `panelProps` onto the panel and render `dialogs` alongside
 * it, outside whatever the tile dismissed.
 */
export function useQuickCreatePick() {
  const { project } = useProject();
  const [activeType, setActiveType] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [bindSecretOpen, setBindSecretOpen] = useState(false);
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const ctxFolder = useAddContextFolder({ project });
  const { checkLoginAndProceed, showLoginDialog, closeLoginDialog } = useLoginRequired();

  // A conversation with anyone remote needs a cloud session, so gate before
  // opening — and reopen the dialog the user was reaching for once a forced
  // login completes.
  const onNewMessage = () => {
    if (!checkLoginAndProceed(ActionType.START_CONVERSATION, undefined, undefined, { forceLogin: true })) return;
    setNewMessageOpen(true);
  };
  useResumeAfterLogin(ActionType.START_CONVERSATION, () => setNewMessageOpen(true));

  // A type whose on-disk location is already fixed by TypeInfo brings its own
  // dialog — the generic name+path form would only ask it questions it can't
  // answer. Chosen here, not inside QuickCreateDialog, so the generic form's
  // project fetch + snapshot never run for a type that discards them.
  const CustomDialog = activeType ? getDescriptor(activeType)?.Dialog : undefined;

  const handleDialogChange = (next: boolean) => {
    setDialogOpen(next);
    if (!next) setActiveType(null);
  };

  const onPick = (type: string) => {
    setActiveType(type);
    setDialogOpen(true);
  };

  const dialogs = (
    <>
      {CustomDialog ? (
        <CustomDialog open={dialogOpen} onOpenChange={handleDialogChange} projectId={project?.id ?? null} />
      ) : (
        <QuickCreateDialog open={dialogOpen} onOpenChange={handleDialogChange} type={activeType} />
      )}
      <BindSecretDialog project={project ?? null} open={bindSecretOpen} onOpenChange={setBindSecretOpen} />
      {ctxFolder.dialogs}
      <NewConversationDialog open={newMessageOpen} onClose={() => setNewMessageOpen(false)} />
      <LoginDialog open={showLoginDialog} onOpenChange={closeLoginDialog} />
    </>
  );

  const panelProps: PanelHandlers = {
    onPick,
    onBindSecret: () => setBindSecretOpen(true),
    onAddFolder: ctxFolder.pick,
    onNewMessage,
  };

  return { panelProps, dialogs };
}

/** What the panel needs from its host — everything but the host's own dismiss
 *  and the display-only `sections` filter. */
export type PanelHandlers = Omit<QuickCreatePanelProps, 'onDone' | 'sections' | 'extraSessionTiles'>;

/** The tile groups this panel can render, in order. */
export type QuickCreateSection = 'session' | 'message' | 'asset' | 'folder';
export const ALL_SECTIONS: QuickCreateSection[] = ['session', 'message', 'asset', 'folder'];

export interface QuickCreatePanelProps {
  /** Open the per-type create dialog (name / folder / scope) for an asset type. */
  onPick: (type: string) => void;
  /** Open the secret-binding dialog. */
  onBindSecret: () => void;
  /** Run a context-folder source at the given scope. */
  onAddFolder: (source: ContextFolderSource, scope: ContextFolderScope) => void;
  /** Open the new-conversation dialog (behind the cloud-login gate). */
  onNewMessage: () => void;
  /** Dismiss the host, if there is one to dismiss. A modal closes; a page no-ops. */
  onDone?: () => void;
  /**
   * Which tile groups to render, in this order. Defaults to all four (the "+"
   * modal). The tabbed ProjectHome splits: `session` renders under its own
   * tagged wrapper, `asset` + `folder` below the mini-desktop.
   */
  sections?: QuickCreateSection[];
  /**
   * Host-supplied tiles appended to the `session` group — e.g. ProjectHome's
   * Terminal opener, whose creation path (and modals) live on the terminal
   * strip controller rather than in this panel.
   */
  extraSessionTiles?: SessionTileDef[];
}

/** The session-tile shape hosts use for {@link QuickCreatePanelProps.extraSessionTiles}. */
export interface SessionTileDef {
  key: string;
  Icon: TileIcon;
  label: string;
  wikiword: string;
  iconClassName?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * QuickCreatePanel — every "create new" option as a grid of square icon tiles,
 * grouped into sessions / assets / folders.
 *
 * The options themselves, with no chrome around them: `QuickCreateModal` puts
 * them in a dialog behind the desktop "+" tile, and `ProjectHome` spreads them
 * straight onto the page. Coding-agent sessions launch immediately; everything
 * that needs a dialog defers to the host, because a tile click dismisses the
 * modal host — and a dialog this panel owned would unmount with it.
 */
export function QuickCreatePanel({
  onPick,
  onBindSecret,
  onAddFolder,
  onNewMessage,
  extraSessionTiles = [],
  onDone,
  sections = ALL_SECTIONS,
}: QuickCreatePanelProps) {
  const { t } = useLingui();
  // Only `creatable`/`type_name` are read below, both synchronous from the
  // registry — no vaults, so no `/assets/types` request per mount.
  const { types: serverTypes } = useAssetTypes({ withVaults: false });
  const { project: currentProject } = useProject();
  const { navigation } = useDockNavigation();
  const [folderScope, setFolderScope] = useState<ContextFolderScope>('private');

  // Coding-agent sessions launch a live AgenticProcess immediately, then we
  // navigate to its terminal dock pointer (URL-first; the loader owns the view).
  // Not memoized: `onDone` is a fresh arrow from the modal host every render, so
  // a useCallback here could never hit, and no consumer is memo'd anyway.
  const handleStartSession = async (workerType: 'claude_code' | 'codex' | 'copilot' | 'opencode') => {
    onDone?.();
    // openNewChat creates AND navigates (carrying the chat mode) — no second nav.
    // The catch is load-bearing: this is invoked as `void handleStartSession(…)`,
    // so a rejected create used to become an unhandled rejection and the user got
    // no feedback at all in any view mode.
    try {
      const process = await openNewChat(navigation, { workerType });
      if (!process) notify.error({ title: t`Failed to start session` });
    } catch (err) {
      console.error('[QuickCreatePanel] start session failed', err);
      openCapabilitiesForWorker(navigation, workerType);
    }
  };

  // Intersection of the UI registry and the server-reported `creatable` types,
  // so the server stays authoritative for what's actually supported. Types in
  // HIDDEN_ASSET_TYPES are omitted from this launcher. Labels come from the
  // descriptor — per-type wording belongs to the registry, not this call site.
  const assetItems = useMemo(() => {
    const serverCreatable = new Set(serverTypes.filter((t) => t.creatable).map((t) => t.type_name));
    const enforce = serverCreatable.size > 0;
    return (
      QUICK_CREATE_REGISTRY.filter((d) => !HIDDEN_ASSET_TYPES.has(d.type))
        .filter((d) => !enforce || serverCreatable.has(d.type))
        // Glyph from the backend type registry — never a per-type icon chosen here.
        // `t(d.label)` and NOT `labelForType`: this launcher creates ONE of a
        // thing, so it needs the descriptor's singular ("Skill"), while the type
        // registry's label is whatever that type calls a section of them
        // ("Skills"). Same word, different number — translating the wrong one
        // gives a "New Skills" tile.
        .map((d) => ({
          type: d.type,
          Icon: iconForType(d.type) as TileIcon,
          label: t(d.label),
          wikiword: d.wikiword,
        }))
    );
  }, [serverTypes, t]);

  const sessionTiles: Array<{
    key: string;
    Icon: TileIcon;
    label: string;
    wikiword: string;
    iconClassName: string;
    onClick: () => void;
  }> = [
    // Glyph and colour come from `PROVIDER_META`; only the label and wiki page
    // are this surface's own. Hardcoding the icon here is how a vendor ends up
    // wearing Claude's mark on one screen and its own on another.
    ...(
      [
        ['claude_code', t`Claude Code`, CLAUDE_CODE_WIKI],
        ['codex', t`Codex`, CODEX_WIKI],
        ['copilot', t`Copilot`, COPILOT_WIKI],
        ['opencode', t`OpenCode`, OPENCODE_WIKI],
      ] as const
    ).map(([workerType, label, wikiword]) => {
      const meta = providerMetaFor(workerType);
      return {
        key: workerType,
        Icon: meta.Icon,
        label,
        wikiword,
        iconClassName: meta.iconClassName,
        onClick: () => void handleStartSession(workerType),
      };
    }),
  ];

  // Folder tiles are the context-folder sources, flattened out of the "+"
  // dialog they otherwise hide behind. Scope is read synchronously on click and
  // passed by value, so the host still has it after this panel unmounts.
  const folderSources = useContextFolderSources();

  // Project-attachment tiles — secret bindings live on the Project entity, not
  // as creatable file assets, so they are hardcoded here rather than in
  // QUICK_CREATE_REGISTRY. This is the entry point for adding them: the
  // ProjectHome cards only render once non-empty.
  const projectAttachmentTiles: Array<{
    key: string;
    Icon: TileIcon;
    label: string;
    wikiword: string;
    disabled?: boolean;
    onClick: () => void;
  }> = [
    {
      key: 'secret',
      Icon: KeyRound,
      label: t`Secret`,
      wikiword: SECRET_WIKI,
      disabled: !currentProject,
      onClick: () => {
        onDone?.();
        onBindSecret();
      },
    },
  ];

  // Keyed by section so `sections` controls both membership AND order — the
  // group is looked up, not laid out, so the caller's order is what renders.
  const bySection: Record<QuickCreateSection, ReactNode> = {
    session: (
      <TileSection title={<Trans>New session</Trans>}>
        {[...sessionTiles, ...extraSessionTiles].map((tile) => (
          <TippedTile
            key={tile.key}
            wikiword={tile.wikiword}
            label={tile.label}
            Icon={tile.Icon}
            iconClassName={tile.iconClassName}
            disabled={tile.disabled}
            onClick={tile.onClick}
          />
        ))}
      </TileSection>
    ),
    // A conversation is a message to a person, not an agent session, and not a
    // file asset — hence its own section and a hardcoded tile (the asset grid is
    // registry types filtered by server `creatable`, and `conversation` is neither).
    message: (
      <TileSection title={<Trans>New message</Trans>}>
        <TippedTile
          wikiword={CONVERSATION_WIKI}
          Icon={MessageSquarePlus}
          label={t`Message`}
          data-testid="quick-create-message"
          onClick={() => {
            onDone?.();
            onNewMessage();
          }}
        />
      </TileSection>
    ),
    asset: (
      <TileSection title={<Trans>New asset</Trans>}>
        {assetItems.map((item) => (
          <TippedTile
            key={item.type}
            wikiword={item.wikiword}
            Icon={item.Icon}
            label={item.label}
            onClick={() => {
              onDone?.();
              onPick(item.type);
            }}
          />
        ))}
        {projectAttachmentTiles.map((tile) => (
          <TippedTile
            key={tile.key}
            wikiword={tile.wikiword}
            Icon={tile.Icon}
            label={tile.label}
            disabled={tile.disabled}
            onClick={tile.onClick}
          />
        ))}
      </TileSection>
    ),
    folder: (
      <TileSection
        title={
          <span className="flex items-center gap-1">
            {/* Sentence case, matching the sibling headings ("New session",
                "New asset") and the AddContextFolderDialog title — same string,
                one catalog entry. */}
            <Trans>Add context folder</Trans>
            <Tooltip delayDuration={150}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t`What is a context folder?`}
                  className="text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              {/* pointer-events-auto: portals to <body>, which the modal Dialog
                  marks pointer-events:none (see ContextFolderScopeChips). */}
              <TooltipContent side="top" className="pointer-events-auto flex max-w-[280px] items-start gap-2">
                <span className="text-xs leading-snug text-muted-foreground">
                  <Trans>
                    Point this project at another folder so agents can read it as background — code, docs or assets that
                    live outside the project, without copying anything.
                  </Trans>
                </span>
                <WikiButton wikiword={CONTEXT_FOLDERS_WIKI} label={t`What is a context folder?`} />
              </TooltipContent>
            </Tooltip>
          </span>
        }
        headerExtra={<ContextFolderScopeChips scope={folderScope} onChange={setFolderScope} />}
      >
        {folderSources.map((source) => (
          <TippedTile
            key={source.key}
            wikiword={source.wikiword}
            Icon={source.Icon}
            label={source.label}
            tip={source.tip}
            data-testid={source.testId}
            disabled={!currentProject}
            onClick={() => {
              onDone?.();
              onAddFolder(source.key, folderScope);
            }}
          />
        ))}
      </TileSection>
    ),
  };

  return (
    <div className="flex flex-col gap-4 pt-1" data-testid="quick-create-panel">
      {sections.map((s) => (
        <Fragment key={s}>{bySection[s]}</Fragment>
      ))}
    </div>
  );
}
