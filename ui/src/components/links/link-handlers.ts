/**
 * Runs a link action — the one place an action id (`link-actions.ts`) becomes a call.
 * Navigation goes through `NavigationActions`; preview and copy are the two actions
 * that stay on the page.
 */
import apiClient from '@sdk/client';
import { dataContext, fsStore, openTerminalFromComputeNode, Shell, type AgenticProcess } from '@sdk';
import { t } from '@lingui/core/macro';
import { errorMessage } from '@src/lib/error-message';
import { commandOf, isWebUrl, lightboxMediaName, linkKind as kindOf } from '@src/lib/link-kind';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { notify } from '@src/notifications/notify';
import type { CommandMode, LinkActionId } from './link-actions';
import type { LinkSource } from './link-events';

export interface LinkMedia {
  url: string;
  name: string;
}

/** The browser profile a command's pages open in; null is the system default. */
export type CommandBrowser = { browser: string; profile: string } | null;

export type LinkAction =
  | { id: Exclude<LinkActionId, 'browser-profile' | 'command-browser'> }
  | { id: 'browser-profile'; browser: string; profile: string }
  | { id: 'command-browser'; choice: CommandBrowser };

export interface LinkHandlerDeps {
  navigation: NavigationActions;
  source: LinkSource | null;
  host: AgenticProcess | null;
  preview: (media: LinkMedia) => void;
  /** The browser profile command links open pages in. */
  commandBrowser?: CommandBrowser;
}

/** Whether `process` can run a command in its own session (its vendor's shell mode, e.g. Claude Code's `!`). */
export function runsShellMode(process: AgenticProcess | null): boolean {
  return !!process?.supports_shell_command;
}

/** A plain terminal (no agent behind it) that a command can be typed into. */
export function plainShell(source: LinkSource | null): Shell | null {
  return source instanceof Shell && !source.agentic_process_id ? source : null;
}

/** `command` with `BROWSER` set to `browser`, written for the shell that reads it (`target`). */
async function withBrowser(command: string, browser: CommandBrowser, target: 'session' | 'terminal'): Promise<string> {
  if (!browser) return command;
  const data = await apiClient.post<{ command: string }>('/api/v1/browser-profiles/command', {
    ...browser,
    command,
    target,
  });
  return data.command;
}

/** Run a command link's command where `mode` says. */
async function runCommand(mode: CommandMode, link: string, deps: LinkHandlerDeps): Promise<void> {
  const { source, host, navigation } = deps;
  const browser = deps.commandBrowser ?? null;
  const command = commandOf(link);
  const cwd = host?.workdir ?? (source as { workdir?: string | null } | null)?.workdir ?? undefined;
  if (mode === 'run-here') {
    const shell = plainShell(source);
    if (shell) {
      await shell.sendInput(`${await withBrowser(command, browser, 'terminal')}\r`);
      return;
    }
    if (host && runsShellMode(host)) {
      await host.runShellCommand(await withBrowser(command, browser, 'session'));
      return;
    }
    mode = 'run-flowpad';
  }
  if (mode === 'run-flowpad') {
    await navigation.openNewShell({ startCommand: await withBrowser(command, browser, 'terminal'), cwd });
    return;
  }
  const nodeId = dataContext.computeNode?.id;
  if (!nodeId) throw new Error(t`No machine to open a terminal on`);
  await openTerminalFromComputeNode(nodeId, command, cwd, browser);
}

/**
 * The bytes behind an image/video link: a web URL as itself, a file reference as the
 * source's own machine serves it (the path the backend resolved, on its compute node).
 * A source on no node — a headless chat, a message — resolved its path on this machine,
 * which is where the backend looked (`Entity.link_node`).
 */
async function mediaFor(link: string, source: LinkSource | null): Promise<LinkMedia | null> {
  const name = lightboxMediaName(link);
  if (!name) return null;
  if (isWebUrl(link)) return { url: link, name };
  if (!source) return null;
  const node = source.computeNodeTypeId ?? LOCAL_COMPUTE_NODE;
  const path = (await source.resolveDisplayTarget(link))?.path;
  return path ? { url: fsStore.getState().getDownloadUrl(node, path), name } : null;
}

function copyLink(link: string): void {
  navigator.clipboard.writeText(link).then(
    () => notify.success({ title: t`Link copied` }),
    (error: unknown) =>
      notify.error({
        title: t`Could not copy link`,
        message: errorMessage(error, t`Clipboard unavailable`),
        forceToast: true,
      }),
  );
}

export async function runLinkAction(action: LinkAction, link: string, deps: LinkHandlerDeps): Promise<void> {
  const { navigation, source, host } = deps;
  switch (action.id) {
    case 'run-here':
    case 'run-flowpad':
    case 'run-external':
      return runCommand(action.id, link, deps).catch((error: unknown) => {
        notify.error({ title: t`Could not run the command`, message: errorMessage(error, String(error)), forceToast: true });
      });
    case 'command-browser':
    case 'menu':
      // Choosing the profile is the menu's state (it persists the pick); `menu` is opened by the surface.
      return;
    case 'preview': {
      // Media previews in place; anything the preview can't resolve opens as a tab, which
      // also reports the failure the way every other link does.
      const media = await mediaFor(link, source).catch(() => null);
      if (media) deps.preview(media);
      else await navigation.openLink(link, source);
      return;
    }
    case 'show-in-display':
      if (host) await navigation.showLinkInDisplay(link, host);
      return;
    case 'open':
      return navigation.openLink(link, source);
    case 'vibe':
      if (host) await navigation.openLinkInVibe(link, source, host);
      return;
    case 'browser':
      return navigation.openLinkInBrowser(link, source);
    case 'browser-profile':
      return navigation.openLinkInBrowserProfile(link, source, action.browser, action.profile);
    case 'copy':
      return copyLink(kindOf(link, window.location.origin) === 'command' ? commandOf(link) : link);
  }
}
