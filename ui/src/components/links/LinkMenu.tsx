import { dataContext, instancePreferences, PrefKey, type AgenticProcess } from '@sdk';
import { t } from '@lingui/core/macro';
import {
  AppWindow,
  Check,
  Copy,
  ExternalLink,
  Globe,
  MessageSquare,
  Monitor,
  PanelTop,
  Sparkles,
  SquareTerminal,
  TerminalSquare,
} from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { MediaLightbox } from '@src/components/ui/media-lightbox';
import { Checkbox } from '@src/components/ui/checkbox';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { BrowserProfileItems } from './BrowserProfileItems';
import { useBrowserProfiles } from '@src/lib/browser-profiles';
import { commandOf, lightboxMediaName, linkKind } from '@src/lib/link-kind';
import { COMMAND_MODES, linkActions, type CommandMode, type LinkActionId, type LinkSurface } from './link-actions';
import type { LinkHandlers, LinkSource } from './link-events';
import { plainShell, runLinkAction, type CommandBrowser, type LinkAction, type LinkMedia } from './link-handlers';
import { useDockNavigation } from '@src/navigation';

export interface Links {
  /** Stable for the surface's lifetime. */
  handlers: LinkHandlers;
  /** Render beside the surface; stable, so the surface never re-renders for the menu. */
  menu: ReactNode;
}

export interface LinkOptions {
  /** `vibe` only for the surface whose process owns the vibe Display it sits beside. */
  surface?: LinkSurface;
  /** False when the text was written by another person: a command then opens its menu instead of running. */
  trusted?: boolean;
}

const lastMode = (): CommandMode => {
  const mode = instancePreferences.get(PrefKey.COMMAND_LINK_MODE) as CommandMode;
  return COMMAND_MODES.includes(mode) ? mode : 'run-here';
};
const commandBrowser = (): CommandBrowser => (instancePreferences.get(PrefKey.COMMAND_LINK_BROWSER) as CommandBrowser) ?? null;

/** The source's machine is the user's own (or it names none): its windows and browsers are on this screen. */
function onLocalNode(source: { computeNodeTypeId?: { id: string } | null } | null): boolean {
  const node = source?.computeNodeTypeId?.id;
  return !node || node === '@local' || node === dataContext.computeNode?.id;
}

interface LinkMenuHandle {
  /** `primary` is what a click does, marked as the default in the menu. */
  open: (link: string, x: number, y: number, items: LinkActionId[], primary: LinkActionId | null) => void;
}

interface CommandConfirmHandle {
  /** Resolves true when the user approves running `command` in `mode`. */
  ask: (command: string, mode: CommandMode) => Promise<boolean>;
}

interface LinkPreviewHandle {
  show: (media: LinkMedia) => void;
}

/**
 * A link surface's click and right-click, composed from the three layers: what the link
 * is (`link-kind`), what can be done with it (`linkActions`), and the one runner
 * (`runLinkAction`). Click runs the primary action; right-click lists the menu. Every
 * link surface (terminal, message, chat) shares this.
 */
export function useLinks(
  source: RefObject<LinkSource | null>,
  process?: AgenticProcess | null,
  { surface = 'tab', trusted = true }: LinkOptions = {},
): Links {
  const { navigation } = useDockNavigation();
  // Read the current navigation/process without retaining a surface render's closure.
  const navRef = useRef(navigation);
  navRef.current = navigation;
  const processRef = useRef(process ?? null);
  processRef.current = process ?? null;
  const menuRef = useRef<LinkMenuHandle>(null);
  const previewRef = useRef<LinkPreviewHandle>(null);
  const confirmRef = useRef<CommandConfirmHandle>(null);

  return useMemo(() => {
    const plan = (link: string) =>
      linkActions({
        kind: linkKind(link, window.location.origin),
        media: lightboxMediaName(link) !== null,
        surface,
        host: processRef.current !== null,
        here: !!processRef.current?.supports_shell_command || plainShell(source.current) !== null,
        localNode: onLocalNode(source.current),
        trusted,
        lastMode: lastMode(),
      });
    const run = async (action: LinkAction, link: string) => {
      const mode = isMode(action.id) ? action.id : null;
      // Nothing runs on this machine without the user's approval, unless they said not to ask again.
      if (mode && instancePreferences.get(PrefKey.COMMAND_LINK_CONFIRM) !== false) {
        if (!(await confirmRef.current?.ask(commandOf(link), mode))) return;
      }
      void runLinkAction(action, link, {
        navigation: navRef.current,
        source: source.current,
        host: processRef.current,
        preview: (media) => previewRef.current?.show(media),
        commandBrowser: commandBrowser(),
      });
    };
    return {
      handlers: {
        activate: (event, link) => {
          const { primary, menu } = plan(link);
          if (primary) void run({ id: primary } as LinkAction, link);
          else menuRef.current?.open(link, event.clientX, event.clientY, menu, primary);
        },
        openMenu: (link, x, y) => {
          const { menu, primary } = plan(link);
          menuRef.current?.open(link, x, y, menu, primary);
        },
      },
      menu: (
        <>
          <LinkMenu
            ref={menuRef}
            onRun={(action, link) => {
              // A mode picked from the menu is what the next click does.
              if (isMode(action.id)) instancePreferences.set(PrefKey.COMMAND_LINK_MODE, action.id);
              void run(action, link);
            }}
          />
          <CommandConfirm ref={confirmRef} />
          <LinkPreview ref={previewRef} />
        </>
      ),
    };
  }, [source, surface, trusted]);
}

const isMode = (id: LinkActionId): id is CommandMode => COMMAND_MODES.includes(id as CommandMode);

const WHERE: Record<CommandMode, () => string> = {
  'run-here': () => t`in this chat's session`,
  'run-flowpad': () => t`in a new Flowpad terminal`,
  'run-external': () => t`in an external terminal window`,
};

/** "Run this command?" with Don't ask again — owns its state, so asking re-renders only this. */
const CommandConfirm = forwardRef<CommandConfirmHandle>(function CommandConfirm(_props, ref) {
  const [state, setState] = useState<{ command: string; mode: CommandMode; resolve: (ok: boolean) => void } | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  useImperativeHandle(
    ref,
    () => ({
      ask: (command, mode) =>
        new Promise<boolean>((resolve) => {
          setDontAsk(false);
          setState({ command, mode, resolve });
        }),
    }),
    [],
  );
  // A promise settles once, so the close that follows a confirm leaves its answer standing.
  const answer = (ok: boolean) => {
    if (ok && dontAsk) instancePreferences.set(PrefKey.COMMAND_LINK_CONFIRM, false);
    state?.resolve(ok);
    setState(null);
  };
  return (
    <ConfirmDialog
      open={state !== null}
      onOpenChange={(open) => !open && answer(false)}
      title={t`Run this command?`}
      description={state ? t`It will run ${WHERE[state.mode]()}.` : ''}
      confirmLabel={t`Run`}
      cancelLabel={t`Cancel`}
      onConfirm={() => answer(true)}
      testId="command-confirm"
    >
      <pre dir="ltr" className="whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs" data-testid="command-confirm-command">
        {state?.command}
      </pre>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={dontAsk} onCheckedChange={(v) => setDontAsk(v === true)} data-testid="command-confirm-dont-ask" />
        {t`Don't ask again`}
      </label>
    </ConfirmDialog>
  );
});

/** Owns the preview state, so showing and closing re-renders only this. */
const LinkPreview = forwardRef<LinkPreviewHandle>(function LinkPreview(_props, ref) {
  const [media, setMedia] = useState<LinkMedia | null>(null);
  useImperativeHandle(ref, () => ({ show: setMedia }), []);
  const close = useCallback(() => setMedia(null), []);
  return media ? <MediaLightbox url={media.url} name={media.name} onClose={close} /> : null;
});

type MenuItemId = Exclude<LinkActionId, 'browser-profile' | 'preview' | 'command-browser'>;

/** How each action reads in the menu. `browser-profile` is the "Open in ▸" submenu. */
const ITEMS: Record<MenuItemId, { label: () => string; icon: typeof Copy }> = {
  copy: { label: () => t`Copy`, icon: Copy },
  'show-in-display': { label: () => t`Show in Display`, icon: Monitor },
  open: { label: () => t`Open in Flowpad`, icon: PanelTop },
  vibe: { label: () => t`Vibe`, icon: Sparkles },
  browser: { label: () => t`Open in browser`, icon: ExternalLink },
  'run-here': { label: () => t`Run in chat`, icon: MessageSquare },
  'run-flowpad': { label: () => t`Run in Flowpad terminal`, icon: SquareTerminal },
  'run-external': { label: () => t`Run in external terminal`, icon: TerminalSquare },
};

/** Owns the menu state, so opening and closing re-renders only this. */
const LinkMenu = forwardRef<LinkMenuHandle, { onRun: (action: LinkAction, link: string) => void }>(function LinkMenu(
  { onRun },
  ref,
) {
  // `id` remounts the menu so a right-click on another link re-anchors it.
  const [state, setState] = useState<{
    link: string;
    x: number;
    y: number;
    items: LinkActionId[];
    primary: LinkActionId | null;
    id: number;
  } | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      open: (link, x, y, items, primary) => setState((prev) => ({ link, x, y, items, primary, id: (prev?.id ?? 0) + 1 })),
    }),
    [],
  );
  // Refetched on every open; the last list stays shown meanwhile, so only the first right-click waits.
  const browsers = useBrowserProfiles(state !== null);

  if (!state) return null;
  const { link, x, y, items, primary, id } = state;
  const command = linkKind(link, window.location.origin) === 'command';
  const chosenBrowser = commandBrowser();
  const pickBrowser = (choice: CommandBrowser) => instancePreferences.set(PrefKey.COMMAND_LINK_BROWSER, choice);
  return (
    <DropdownMenu key={id} open modal={false} onOpenChange={(open) => !open && setState(null)}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-sm" data-testid="link-menu">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground" title={link}>
          {commandOf(link)}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => {
          if (item === 'preview') return null;
          if (item === 'command-browser') {
            return (
              <DropdownMenuSub key={item}>
                <DropdownMenuSubTrigger data-testid="link-menu-command-browser">
                  <Globe className="mr-2 h-4 w-4" />
                  {t`Browser`}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-w-xs">
                    <DropdownMenuItem onSelect={() => pickBrowser(null)} data-testid="link-menu-command-browser-default">
                      <Check className={`mr-2 h-4 w-4 ${chosenBrowser ? 'invisible' : ''}`} />
                      {t`System default`}
                    </DropdownMenuItem>
                    <BrowserProfileItems
                      browsers={browsers}
                      onSelect={(browser, profile) => pickBrowser({ browser, profile })}
                      isSelected={(browser, profile) => chosenBrowser?.browser === browser && chosenBrowser.profile === profile}
                      testIdPrefix="link-menu-command-browser"
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            );
          }
          if (item === 'browser-profile') {
            return browsers.length > 0 ? (
              <DropdownMenuSub key={item}>
                <DropdownMenuSubTrigger data-testid="link-menu-open-in">
                  <AppWindow className="mr-2 h-4 w-4" />
                  {t`Open in`}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-w-xs">
                    <BrowserProfileItems
                      browsers={browsers}
                      onSelect={(browser, profile) => onRun({ id: 'browser-profile', browser, profile }, link)}
                      testIdPrefix="link-menu-profile"
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            ) : null;
          }
          const { label, icon: Icon } = ITEMS[item];
          const isDefault = isMode(item) && item === primary;
          return (
            <DropdownMenuItem
              key={item}
              onSelect={() => onRun({ id: item }, link)}
              data-testid={`link-menu-${item}`}
              data-default={isDefault ? 'true' : undefined}
            >
              <Icon className="mr-2 h-4 w-4" />
              {item === 'copy' && command ? t`Copy command` : label()}
              {isDefault ? <Check className="ml-auto h-4 w-4" aria-label={t`Default`} /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
