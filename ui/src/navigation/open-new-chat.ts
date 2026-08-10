import { AgenticProcess, dataContext, type ComputeNode } from '@sdk';
import { getViewMode, viewModePtyMode } from '@src/contexts/view-mode-context';
import { capabilityErrorFrom, errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { ViewType } from '@src/types/ViewType';
import type { NavigationActions } from './NavigationActions';

export interface OpenNewChatOptions {
  workerType?: 'claude_code' | 'codex' | 'copilot';
  projectId?: string;
  /** Working directory; defaults to the active project's mount path. */
  cwd?: string;
}

/**
 * THE way a front-face "open a chat" action starts a session.
 *
 * One chain, so the chat mode propagates the same way from every entry point —
 * the chats side-menu, the + tab, quick-create, fork. It is deliberately NOT for
 * task runners (wizard, run-on-file, skill eval, analysis, worktree, error
 * recovery): those pin their own transport and must never follow a UI
 * preference.
 *
 * The view mode is the one read, and decides both halves:
 *   - TRANSPORT: only the terminal surface runs an interactive PTY; vibe and
 *     chat are headless print-mode.
 *   - SURFACE: the mode rides `?viewMode=` on the process's own shell URL, so the
 *     URL alone reproduces what the user sees.
 */
export async function openNewChat(
  navigation: Pick<NavigationActions, 'openShellProcess'>,
  options: OpenNewChatOptions = {},
): Promise<AgenticProcess | null> {
  const computeNode: ComputeNode | null = dataContext.computeNode;
  if (!computeNode) {
    console.error('[openNewChat] No compute node');
    return null;
  }
  const mode = getViewMode();
  const ptyMode = viewModePtyMode(mode);
  const project = dataContext.project;

  const process = await computeNode.createProcess(
    {
      workdir: options.cwd || project?.fs_storage_mount_path,
      ...(options.projectId ?? project?.id ? { projectId: options.projectId ?? project?.id } : {}),
      ...(options.workerType ? { workerType: options.workerType } : {}),
      // Headless surfaces stream the transcript as JSON; a PTY has no such stream.
      ...(ptyMode ? {} : { outputFormat: 'stream-json' as const }),
    },
    {
      watchProcess: false,
      visible: ptyMode,
      pty_mode: ptyMode,
    },
  );

  await navigation.openShellProcess(process.id, { viewMode: mode });
  return process;
}

/**
 * Report a failed `openNewChat` — the one place every create surface handles it.
 *
 * The four callers had four behaviours: one navigated with no message at all,
 * one showed axios's "Request failed with status code 500", and two swallowed
 * the rejection entirely. They now share this.
 *
 * A capability refusal (the backend's structured 400: the chosen harness is not
 * installed on this machine) gets the user moved to Capabilities for THAT kind,
 * because the arrival re-probe there is what corrects a stale row and offers
 * install / switch-harness. `fallbackKind` covers a caller that already knows
 * which kind it asked for — used when an older backend answers without the
 * structured payload.
 *
 * The redirect goes through `navigation.openTab`, the same single entry point
 * `TerminalOpenerToolbar` already routes its warned openers to. It owns the
 * `capabilityKind` → `CAPABILITY_PARAM` pointer, so this stays out of the
 * business of spelling a Capabilities URL.
 *
 * The notification is deliberately still emitted alongside the navigation:
 * alert-level toasts are suppressed outside Dev mode (`notifications/notify.ts`),
 * so in Advanced mode this lands in the footer alert log naming the provider,
 * while the redirect is what the user actually sees happen.
 */
export function reportChatStartFailure(
  navigation: Pick<NavigationActions, 'openTab'>,
  error: unknown,
  fallbackKind?: string,
): void {
  const capability = capabilityErrorFrom(error);
  const kind = capability?.capabilityKind ?? fallbackKind;

  if (!capability && !kind) {
    console.error('[openNewChat] start failed', error);
    notify.error({
      id: 'chat-start-failed',
      title: 'Could not start chat',
      message: errorMessage(error, 'The session could not be created.'),
    });
    return;
  }

  notify.error({
    id: 'chat-start-failed',
    title: 'Could not start chat',
    message: errorMessage(
      error,
      `${capability?.name ?? 'This provider'} is not available on this machine.`,
    ),
  });

  navigation.openTab(ViewType.CAPABILITIES, kind ? { capabilityKind: kind } : undefined);
}
