import { AgenticProcess, dataContext, type ComputeNode } from '@sdk';
import { chatModeNavOptions, chatModePtyMode, getChatMode } from '@src/contexts/chat-ui-mode-context';
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
 * The mode comes from `getChatMode()` — one read, defaulting to vibe — and
 * decides both halves:
 *   - TRANSPORT: only `terminal` runs an interactive PTY; `chat` and `vibe` are
 *     headless print-mode.
 *   - SURFACE: `vibe` opens the vibe workspace (`?viewMode=vibe`); the other two
 *     ride `?chatMode=` on the process's own shell URL.
 * Both land on the process dock, so the URL alone reproduces what the user sees.
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
  const mode = getChatMode();
  const ptyMode = chatModePtyMode(mode);
  const project = dataContext.project;

  const process = await computeNode.createProcess(
    {
      workdir: options.cwd || project?.fs_storage_mount_path,
      ...(options.projectId ?? project?.id ? { projectId: options.projectId ?? project?.id } : {}),
      ...(options.workerType ? { workerType: options.workerType } : {}),
      // Headless modes stream the transcript as JSON; a PTY has no such stream.
      ...(ptyMode ? {} : { outputFormat: 'stream-json' as const }),
    },
    {
      watchProcess: false,
      visible: ptyMode,
      pty_mode: ptyMode,
    },
  );

  await navigation.openShellProcess(process.id, chatModeNavOptions(mode));
  return process;
}
