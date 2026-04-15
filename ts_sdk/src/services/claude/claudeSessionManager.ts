import { EventEmitter } from 'events';

/**
 * ClaudeSessionManager — Singleton coordinator for Claude session lifecycle.
 *
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
