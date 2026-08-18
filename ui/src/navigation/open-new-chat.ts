import { AgenticProcess, dataContext, type ComputeNode } from '@sdk';
import { getViewMode, surfaceForViewMode, viewModePtyMode } from '@src/contexts/view-mode-context';
import { embedStandardAgent } from './embed-standard-agent';
import type { NavigationActions } from './NavigationActions';

export interface OpenNewChatOptions {
  workerType?: 'claude_code' | 'codex' | 'copilot' | 'opencode';
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
 * The view mode is the one read, and decides all three of:
 *   - TRANSPORT: only the terminal surface runs an interactive PTY; vibe and
 *     chat are headless print-mode.
 *   - SURFACE: the mode rides `?viewMode=` on the process's own shell URL, so the
 *     URL alone reproduces what the user sees.
 *   - PERSONA: only the chat surface embeds the `standard` agent, which carries
 *     the `flow show` presentation contract. Terminal is a raw passthrough, and
 *     vibe embeds `vibe` through its own creation path.
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
  // Chat surface only: terminal is a raw PTY passthrough where the user drives
  // the CLI directly, and vibe embeds its own persona via
  // createVibeProcessForProject. Awaited before returning so a caller that
  // prompts on the returned process can't race the load-embedded-subagent round
  // trip — the persona has to be on disk before the FIRST turn, since
  // prepare_system_instruction_assets() builds the system prompt per turn.
  // Never throws (see embedStandardAgent), so the `void openNewChat(...)`
  // callers keep their existing failure semantics.
  if (surfaceForViewMode(mode) === 'chat') {
    await embedStandardAgent(process);
  }
  return process;
}
