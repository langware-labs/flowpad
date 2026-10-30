import { dataContext, instancePreferences, PrefKey, type AgenticProcess } from '@sdk';
import { t } from '@lingui/core/macro';
import { AppWindow, Check, Copy, ExternalLink, Globe, MessageSquare, Monitor, PanelTop, Sparkles, SquareTerminal, TerminalSquare } from 'lucide-react';
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
import { BrowserProfileItems } from './BrowserProfileItems';
import { useBrowserProfiles } from '@src/lib/browser-profiles';
import { commandOf, lightboxMediaName, linkKind } from '@src/lib/link-kind';
import { COMMAND_MODES, linkActions, type CommandMode, type LinkActionId, type LinkSurface } from './link-actions';
import type { LinkHandlers, LinkSource } from './link-events';
import { plainShell, runLinkAction, runsShellMode, type CommandBrowser, type LinkAction, type LinkMedia } from './link-handlers';
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
  open: (link: string, x: number, y: number, items: LinkActionId[], primary: LinkActionId) => void;
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

  return useMemo(() => {
    const plan = (link: string) =>
      linkActions({
        kind: linkKind(link, window.location.origin),
        media: lightboxMediaName(link) !== null,
        surface,
        host: processRef.current !== null,
        here: runsShellMode(processRef.current) || plainShell(source.current) !== null,
        localNode: onLocalNode(source.current),
        trusted,
        lastMode: lastMode(),
      });
    const run = (action: LinkAction, link: string, picked = false) => {
      // A mode picked from the menu is what the next click does; a picked browser is used from now on.
      if (picked && COMMAND_MODES.includes(action.id as CommandMode)) instancePreferences.set(PrefKey.COMMAND_LINK_MODE, action.id);
      if (action.id === 'command-browser') instancePreferences.set(PrefKey.COMMAND_LINK_BROWSER, action.choice);
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
          if (primary === 'menu') menuRef.current?.open(link, event.clientX, event.clientY, menu, primary);
          else run({ id: primary } as LinkAction, link);
        },
        openMenu: (link, x, y) => {
          const { menu, primary } = plan(link);
          menuRef.current?.open(link, x, y, menu, primary);
        },
      },
      menu: (
        <>
          <LinkMenu ref={menuRef} onRun={run} />
          <LinkPreview ref={previewRef} />
        </>
      ),
    };
  }, [source, surface, trusted]);
}

/** Owns the preview state, so showing and closing re-renders only this. */
const LinkPreview = forwardRef<LinkPreviewHandle>(function LinkPreview(_props, ref) {
  const [media, setMedia] = useState<LinkMedia | null>(null);
  useImperativeHandle(ref, () => ({ show: setMedia }), []);
  const close = useCallback(() => setMedia(null), []);
  return media ? <MediaLightbox url={media.url} name={media.name} onClose={close} /> : null;
});

type MenuItemId = Exclude<LinkActionId, 'browser-profile' | 'preview' | 'command-browser' | 'menu'>;

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
const LinkMenu = forwardRef<LinkMenuHandle, { onRun: (action: LinkAction, link: string, picked?: boolean) => void }>(function LinkMenu(
  { onRun },
  ref,
) {
  // `id` remounts the menu so a right-click on another link re-anchors it.
  const [state, setState] = useState<{
    link: string;
    x: number;
    y: number;
    items: LinkActionId[];
    primary: LinkActionId;
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
  return (
    <DropdownMenu key={id} open modal={false} onOpenChange={(open) => !open && setState(null)}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-sm" data-testid="link-menu">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground" title={link}>
          {command ? commandOf(link) : link}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => {
          if (item === 'preview' || item === 'menu') return null;
          if (item === 'command-browser') {
            const pick = (choice: CommandBrowser) => onRun({ id: 'command-browser', choice }, link);
            const isChosen = (b: string, p: string) => chosenBrowser?.browser === b && chosenBrowser.profile === p;
            return (
              <DropdownMenuSub key={item}>
                <DropdownMenuSubTrigger data-testid="link-menu-command-browser">
                  <Globe className="mr-2 h-4 w-4" />
                  {t`Browser`}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-w-xs">
                    <DropdownMenuItem onSelect={() => pick(null)} data-testid="link-menu-command-browser-default">
                      <Check className={`mr-2 h-4 w-4 ${chosenBrowser ? 'invisible' : ''}`} />
                      {t`System default`}
                    </DropdownMenuItem>
                    {browsers.flatMap((b) =>
                      b.profiles.map((p) => (
                        <DropdownMenuItem
                          key={`${b.id}-${p.id}`}
                          onSelect={() => pick({ browser: b.id, profile: p.id })}
                          data-testid={`link-menu-command-browser-${b.id}-${p.id}`}
                        >
                          <Check className={`mr-2 h-4 w-4 ${isChosen(b.id, p.id) ? '' : 'invisible'}`} />
                          <span className="truncate">
                            {b.name} — {p.email ?? p.name}
                          </span>
                        </DropdownMenuItem>
                      )),
                    )}
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
          const isMode = COMMAND_MODES.includes(item as CommandMode);
          return (
            <DropdownMenuItem
              key={item}
              onSelect={() => onRun({ id: item }, link, isMode)}
              data-testid={`link-menu-${item}`}
              data-default={isMode && item === primary ? 'true' : undefined}
            >
              <Icon className="mr-2 h-4 w-4" />
              {item === 'copy' && command ? t`Copy command` : label()}
              {isMode && item === primary ? <Check className="ml-auto h-4 w-4" aria-label={t`Default`} /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
