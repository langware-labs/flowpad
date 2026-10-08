/**
 * The UI actions the smart navigator can answer with (`action:<id>`): a button, a dialog, a menu.
 *
 * The ids and what each does are the backend's catalog (`flow_sdk/core/ui_actions.json`) -- what
 * the model chooses between. This file is the other half: one handler per id. A unit test holds
 * the two to the same ids.
 *
 * Two kinds of handler:
 * - **plain** -- callable from anywhere (go back, reload, the spotlight, a new chat, log out);
 * - **requested** -- the dialog lives in a component's own state (the publish dialog on Project
 *   home, the settings dialog in the user menu). The handler first opens the screen that hosts it
 *   (URL-first, like any other navigation), then REQUESTS the action; the host hears the request
 *   (`useUiActionRequest`) -- at once when mounted, or when it mounts.
 */

import { useEffect, useRef } from 'react';

import { dataContext } from '@sdk';
import { openSetupWizard } from '@src/components/setup-incomplete/open-setup-wizard';
import { ViewMode } from '@src/contexts/view-mode-context';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { openNewChat } from '@src/navigation/open-new-chat';
import { tryParseDock } from '@src/navigation/try-parse-dock';
import { openSpotlight } from '@src/store/use-spotlight-store';

/** What a handler needs that only the React tree has: navigation, and the theme. */
export interface UiActionHost {
  navigation: NavigationActions;
  toggleTheme: () => void;
}

let host: UiActionHost | null = null;

/** Mounted once, inside the router (`UiActionBridge`). */
export function setUiActionHost(next: UiActionHost | null): void {
  host = next;
}

// ── requested actions ───────────────────────────────────────────────────────────

const REQUEST_EVENT = 'flowpad:ui-action';
/** Requests not yet heard: a host that mounts after the request (its screen just opened) takes it. */
const pending = new Set<string>();

/** Ask the component that hosts `id` to carry it out. */
export function requestUiAction(id: string): void {
  pending.add(id);
  window.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { id } }));
}

/** In a host component: run `fn` when one of `ids` is requested -- now, or already pending. The
 *  latest `fn` is used, so a host may pass an inline closure without re-subscribing every render. */
export function useUiActionRequest(ids: readonly string[], fn: (id: string) => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  const key = ids.join('|');
  useEffect(() => {
    const listening = key ? key.split('|') : [];
    const take = (id: string) => {
      if (listening.includes(id) && pending.delete(id)) latest.current(id);
    };
    for (const id of [...pending]) take(id);
    const listener = (event: Event) => take((event as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener(REQUEST_EVENT, listener);
    return () => window.removeEventListener(REQUEST_EVENT, listener);
  }, [key]);
}

// ── the handlers ──────────────────────────────────────────────────────────────

type Handler = (h: UiActionHost) => void | Promise<unknown>;

/** Request `id` from the component that hosts it -- opening `address` first when the host is a screen
 *  (null: the host is always mounted -- the top bar, the user menu, the app root). `notInVibe`: vibe
 *  mode does not show that screen (Project home), so from vibe it opens in standard mode, where the
 *  button the action stands for is. */
const hosted =
  (id: string, address: string | null = null, { notInVibe = false } = {}): Handler =>
  (h) => {
    const dock = address ? tryParseDock(address) : null;
    if (dock) {
      const leave = notInVibe && h.navigation.here.viewMode === ViewMode.Vibe;
      h.navigation.openDock(leave ? dock.withViewMode(ViewMode.Standard) : dock);
    }
    requestUiAction(id);
  };

/** Switch the view mode the way the footer toggle does (URL-first). ``ViewMode`` is read when the
 *  action runs -- this module loads inside an import cycle with the view-mode context. */
const switchMode = (h: UiActionHost, mode: 'vibe' | 'advanced') =>
  h.navigation.openDock(
    h.navigation.here.withViewMode(mode === 'vibe' ? ViewMode.Vibe : ViewMode.Advanced),
    undefined,
    { viewModeSwitch: true },
  );

/** Actions whose dialog or menu lives in a mounted component: `{id: the screen hosting it}`. */
const HOSTS: Record<string, string | null> = {
  'bookmarks-menu': null,
  'project-list': null,
  'new-project-dialog': null,
  'open-folder': null,
  'new-project-from-git': null,
  'add-dependency': null,
  ...Object.fromEntries(
    ['agent', 'skill', 'subagent', 'dynamic-workflow', 'task', 'markdown', 'whiteboard', 'mcp', 'credential', 'modal'].map(
      (t) => [`quick-create-${t}`, null],
    ),
  ),
  'new-data-source-dialog': '/dock/data-sources',
  'new-endpoint-dialog-hub': '/dock/hub/llm-endpoints',
  'new-sandbox-hub': '/dock/hub/home',
  'add-machine-hub': '/dock/hub/home',
  'new-conversation-dialog': null,
  'add-help-desk': null,
  'settings-dialog': null,
  'settings-database': null,
  'settings-secrets': null,
  'assistant-chat': null,
};
/** Hosted on Project home, which vibe mode does not show. */
const ON_PROJECT_HOME = ['invite-members', 'publish-dialog', 'git-checks-dialog', 'upload-flowmsg'];

const NEW_CHAT = {
  'new-chat-default-harness': undefined,
  'new-chat-claude-code': 'claude_code',
  'new-chat-codex': 'codex',
  'new-chat-copilot': 'copilot',
  'new-chat-opencode': 'opencode',
} as const;

export const UI_ACTIONS: Record<string, Handler> = {
  'history-back': (h) => h.navigation.goBack(),
  'history-forward': (h) => h.navigation.goForward(),
  reload: () => window.location.reload(),
  'cmd-k-spotlight': () => openSpotlight(),
  'open-in-window': (h) => h.navigation.openDockInWindow(h.navigation.here),
  'theme-toggle': (h) => h.toggleTheme(),
  ...Object.fromEntries(
    Object.entries(NEW_CHAT).map(([id, workerType]): [string, Handler] => [
      id,
      (h) => openNewChat(h.navigation, workerType ? { workerType } : {}),
    ]),
  ),
  'new-terminal': (h) => h.navigation.openNewShell(),
  'restart-session': () => dataContext.agenticProcess?.restart(),
  'fork-session': async (h) => {
    const forked = await dataContext.agenticProcess?.fork(true);
    if (forked) await h.navigation.openShellProcess(forked.id);
  },
  ...Object.fromEntries(Object.entries(HOSTS).map(([id, address]) => [id, hosted(id, address)])),
  ...Object.fromEntries(ON_PROJECT_HOME.map((id) => [id, hosted(id, '/dock/assets/project-home', { notInVibe: true })])),
  'setup-wizard': () => openSetupWizard(),
  'view-mode-vibe': (h) => switchMode(h, 'vibe'),
  'view-mode-advanced': (h) => switchMode(h, 'advanced'),
  logout: () => dataContext.cloudLogout(),
  // The ask-for-help button lives in the assistant's chat: open it, then ask.
  'ask-for-help-dialog': () => {
    requestUiAction('assistant-chat');
    requestUiAction('ask-for-help-dialog');
  },
};

/** Carry out the action `id`. False when there is no such action, or no host to run it yet. */
export function runUiAction(id: string): boolean {
  const handler = UI_ACTIONS[id];
  if (!handler || !host) return false;
  // Only the latest request stands: one no host took (its screen never opened) is not replayed later.
  pending.clear();
  void Promise.resolve(handler(host)).catch((error) => console.warn(`[ui-action] ${id} failed`, error));
  return true;
}
