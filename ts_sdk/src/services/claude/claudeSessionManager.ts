import { EventEmitter } from 'events';

import type { AgenticProcess } from '../../process/agentic-process';
import type { AgenticContext } from '../../process/agentic-context';

/**
 * ClaudeSessionManager — Singleton coordinator for Claude session lifecycle.
 *
 *  - forkSession    — sibling process with same context_data, fresh session
 *  - createAndStartSession — create processor + process + open PTY in one step
 */
export class ClaudeSessionManager extends EventEmitter {
  private static instance: ClaudeSessionManager | null = null;

  private constructor() {
    super();
  }

  /** Get the singleton instance. */
  static getInstance(): ClaudeSessionManager {
    if (!ClaudeSessionManager.instance) {
      ClaudeSessionManager.instance = new ClaudeSessionManager();
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).claudeSessionManager = ClaudeSessionManager.instance;
      }
    }
    return ClaudeSessionManager.instance;
  }

  /** Reset the singleton (useful for testing). */
  static resetInstance(): void {
    if (ClaudeSessionManager.instance) {
      ClaudeSessionManager.instance.removeAllListeners();
    }
    ClaudeSessionManager.instance = null;
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).claudeSessionManager;
    }
  }

  /**
   * Fork: create a sibling AgenticProcess that resumes from the source
   * session's conversation history but diverges into a new session ID.
   *
   * Uses Claude CLI's `--resume <id> --fork-session` to copy the
   * conversation history into a fresh session.
   *
   * @returns The newly created AgenticProcess (caller should navigate to it).
   */
  async forkSession(process: AgenticProcess): Promise<AgenticProcess> {
    // Build AgenticContext from the existing process's context_data,
    // carrying the source session ID so the backend uses --resume --fork-session
    const ctx = process.context_data ?? {};
    const context: AgenticContext = {
      workdir: (ctx.workdir as string) || undefined,
      model: (ctx.model as string) || undefined,
      permissionMode: (ctx.permission_mode as AgenticContext['permissionMode']) || undefined,
      chrome: (ctx.chrome as boolean) || undefined,
      agentsJson: (ctx.agents_json as Record<string, Record<string, unknown>>) || undefined,
      resumeSessionId: process.session_id || undefined,
      forkSession: true,
    };

    // Create a sibling process on the same compute node
    const { dataContext } = await import('../..');
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('Cannot fork process: no compute node available');

    const newProcess = await computeNode.createProcess(context, { visible: true });

    // Start shell — backend will use --resume <source_id> --fork-session
    await newProcess.start();

    return newProcess;
  }

  /**
   * Create a brand-new AgenticProcess and open its PTY in one step.
   *
   * @param context - AgenticContext with workdir, model, permissionMode, etc.
   * @param options.instruction - Optional prompt to pass as -p flag.
   * @returns The started AgenticProcess (use process.id to navigate).
   */
  async createAndStartSession(
    context: AgenticContext,
    options?: { instruction?: string },
  ): Promise<AgenticProcess> {
    const { dataContext } = await import('../..');
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('No compute node available');

    const process = await computeNode.createProcess(context);
    await process.start(options);
    return process;
  }
}

/** Singleton instance. */
export const claudeSessionManager = ClaudeSessionManager.getInstance();
