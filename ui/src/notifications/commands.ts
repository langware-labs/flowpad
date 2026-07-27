import { toast as sonnerToast } from 'sonner';
import { oauthService, OAUTH_PROVIDERS, copyToClipboard, AgenticProcess, snifferManager } from '@sdk';
import { gitResolvePrompt } from '@src/components/status-bar/gitResolvePrompt';
import { closeTerminalTab } from '@src/tabs/useTabs';
import { useBadgeStore } from './store';
import { notify } from './notify';
import type { NotificationAction } from './types';

/**
 * Imperative command registry for notification actions. A `NotificationAction`
 * carries a serializable `command` key (not a callback) so backend-originated
 * notifications work too; the actual function is looked up here at click time.
 *
 * Navigation actions use `action.href` instead (URL-first) — see `navigateTo`.
 */
export type CommandArgs = Record<string, string | number | boolean>;
type CommandHandler = (args: CommandArgs, ctx: { id: string }) => void;

const registry = new Map<string, CommandHandler>();

export function registerCommand(name: string, fn: CommandHandler): void {
  registry.set(name, fn);
}

export function runCommand(name: string, args: CommandArgs, ctx: { id: string }): void {
  const fn = registry.get(name);
  if (fn) fn(args, ctx);
  else console.warn(`[notify] unknown command '${name}'`);
}

/** Navigation handle, registered URL-first by the command-bridge (react-router). */
let navHandle: ((href: string) => void) | null = null;
export function registerNavigate(fn: (href: string) => void): void {
  navHandle = fn;
}
export function navigateTo(href: string): void {
  if (navHandle) navHandle(href);
  else window.location.assign(href);
}

/** Run a notification action: imperative `command`, else URL-first `href`. */
export function runAction(action: NotificationAction, id: string): void {
  if (action.command) runCommand(action.command, action.args ?? {}, { id });
  else if (action.href) navigateTo(action.href);
}

// --- Static commands (module-level deps; no React hooks) ---------------------

// `Sign in` on the expired-cloud-sign-in toast: relaunch the cloud OAuth flow.
registerCommand('cloud.signin', () => {
  void oauthService.connect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
});

registerCommand('terminal.terminate', (args) => {
  if (args.typeId) void closeTerminalTab(String(args.typeId));
});

// `Resolve` on a failed-push toast: launch an agentic process in the current
// project, seeded with a conflict-resolution prompt for the given branch. Uses
// dataContext.project/computeNode (AgenticProcess.openTab default).
registerCommand('git.resolve-conflict', (args) => {
  const branch = String(args.branch ?? '');
  void AgenticProcess.openTab('claude_code', gitResolvePrompt(branch)).catch((e: unknown) => {
    notify.error({ title: 'Could not start resolver', message: String(e) });
  });
});

// `Disable` on the startup "hook sniffer is on" toast: clear the harness hooks
// (whichever instance installed them) and record the opt-out so a boot doesn't
// silently put them back.
registerCommand('sniffer.disable', (_args, ctx) => {
  void snifferManager
    .disable()
    .then(() => {
      sonnerToast.dismiss(ctx.id);
      notify.success({ title: 'Hook sniffer disabled', message: 'Claude Code hooks were removed from your settings.' });
    })
    .catch((e: unknown) => {
      notify.error({ title: 'Could not disable the sniffer', message: String(e) });
    });
});

registerCommand('notification.dismiss', (_args, ctx) => {
  sonnerToast.dismiss(ctx.id);
  useBadgeStore.getState().remove(ctx.id);
});

// `Detail` on a cloud-error toast. Surfaces the raw transport detail the
// headline hides — visibly (a follow-up toast) AND on the clipboard — instead
// of only writing it to the console (which a user without DevTools never sees).
registerCommand('debug.logHubError', (args) => {
  console.warn('[hub error]', args);

  const str = (v: unknown) =>
    (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').trim();
  const requestLine = `${str(args.method)} ${str(args.path)}`.trim() + (args.statusCode ? ` → ${args.statusCode}` : '');
  const detail = [requestLine, str(args.message)].filter(Boolean).join('\n');

  void copyToClipboard(detail);

  notify.info({
    id: 'cloud-error-detail',
    title: 'Cloud error detail (copied to clipboard)',
    message: detail || 'No additional detail was provided.',
    durationMs: 15000,
  });
});

// `terminal.resume` is hook-bound (useResumeInTerminal) and is registered at
// runtime by <NotificationCommandBridge/>.
