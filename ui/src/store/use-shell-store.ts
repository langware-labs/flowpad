import {
  FlowData,
  FlowDataStream,
  ShellCmdProgress,
  ShellInputFlowData,
  ShellOutputFlowData,
  dataContext,
  type AgenticProcess,
} from '@sdk';
import { create } from 'zustand';

export class ShellSession {
  sessionId: string;
  name: string;
  stream: FlowDataStream;
  createdAt: number;
  isRunning: boolean;

  constructor(sessionId: string, name: string) {
    this.sessionId = sessionId;
    this.name = name;
    this.stream = new FlowDataStream({ id: sessionId, name });
    this.createdAt = Date.now();
    this.isRunning = false;
  }
}

interface ShellState {
  sessions: Map<string, ShellSession>;

  createSession: (sessionId: string, name: string) => void;
  removeSession: (sessionId: string) => void;
  updateSessionName: (sessionId: string, name: string) => void;
  getSession: (sessionId: string) => ShellSession | undefined;
  getAllSessions: () => ShellSession[];

  executeCommand: (command: string, sessionId: string, flow: AgenticProcess | null) => Promise<ShellOutputFlowData>;

  addCommandStream: (sessionId: string, cmdId: string, input: ShellInputFlowData) => void;
  appendToCommandStream: (sessionId: string, cmdId: string, flowData: FlowData) => void;
  clearStream: (sessionId: string) => void;
  clearLog: (sessionId: string) => void; // Alias for clearStream
}

const createDefaultSessions = (): Map<string, ShellSession> => {
  return new Map<string, ShellSession>();
};

export const useShellStore = create<ShellState>((set, get) => ({
  sessions: createDefaultSessions(),

  createSession: (sessionId: string, name: string) => {
    set((state) => {
      if (state.sessions.has(sessionId)) {
        console.warn(`[useShellStore] Session '${sessionId}' already exists`);
        return state;
      }

      const newSession = new ShellSession(sessionId, name);

      return {
        sessions: new Map(state.sessions).set(sessionId, newSession),
      };
    });
  },

  removeSession: (sessionId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(sessionId);
      return { sessions: newSessions };
    });
  },

  updateSessionName: (sessionId: string, name: string) => {
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) {
        console.warn(`[useShellStore] Session '${sessionId}' not found`);
        return state;
      }

      session.name = name;

      return {
        sessions: new Map(state.sessions).set(sessionId, session),
      };
    });
  },

  getSession: (sessionId: string) => {
    return get().sessions.get(sessionId);
  },

  getAllSessions: () => {
    return Array.from(get().sessions.values()).sort((a, b) => a.createdAt - b.createdAt);
  },

  executeCommand: async (command: string, sessionId: string): Promise<ShellOutputFlowData> => {
    const { addCommandStream, appendToCommandStream, getSession } = get();

    const session = getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    session.isRunning = true;

    const input = new ShellInputFlowData(command.trim(), sessionId);
    input.isRunning = true;

    addCommandStream(sessionId, input.id, input);

    try {
      const computeNode = dataContext.computeNode;
      if (!computeNode) {
        throw new Error('[useShellStore] No compute node available');
      }

      // Track final output for return value
      let finalOutput: ShellOutputFlowData | null = null;

      await computeNode.executeCommandStreaming(input, (progress: ShellCmdProgress) => {
        const stdout = progress.stdoutElement?.content ?? '';
        const stderr = progress.stderrElement?.content ?? '';

        console.log('[useShellStore] Progress received:', {
          sessionId,
          cmdId: input.id,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          stdoutDeltaLength: progress.stdoutDelta.length,
          stderrDeltaLength: progress.stderrDelta.length,
          exitCode: progress.exitCode,
        });

        const currentSession = get().sessions.get(sessionId);
        const cmdStream = currentSession?.stream.getSubstream(input.id);

        if (cmdStream) {
          // Create output FlowData with current progress
          const outputFD = new ShellOutputFlowData(stdout, stderr, progress.exitCode ?? undefined);

          appendToCommandStream(sessionId, input.id, outputFD);

          // Track final output for return
          finalOutput = outputFD;
        }
      });

      input.isRunning = false;
      const session = get().getSession(sessionId);
      if (session) session.isRunning = false;

      // Return the final accumulated output
      return finalOutput ?? new ShellOutputFlowData();
    } catch (error) {
      console.error('[useShellStore] Command execution error:', error);

      const errorResult = new ShellOutputFlowData('', error instanceof Error ? error.message : String(error), -1);

      appendToCommandStream(sessionId, input.id, errorResult);

      input.isRunning = false;
      const session = get().getSession(sessionId);
      if (session) session.isRunning = false;

      return errorResult;
    }
  },

  addCommandStream: (sessionId: string, cmdId: string, input: ShellInputFlowData) => {
    console.log(`[useShellStore][${new Date().toISOString()}] addCommandStream called:`, {
      sessionId,
      cmdId,
      command: input.command?.substring(0, 30) || '',
      isRunning: input.isRunning,
    });
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) {
        console.error(`[useShellStore][${new Date().toISOString()}] Session '${sessionId}' not found`);
        return state;
      }

      const existingSubstream = session.stream.getSubstream(cmdId);
      if (existingSubstream) {
        console.warn(`[useShellStore] Command ${cmdId} already exists, skipping add`);
        return state;
      }

      const commandStream = new FlowDataStream({ id: cmdId, name: `cmd-${cmdId}` });
      commandStream.append(input);
      session.stream.addSubstream(commandStream);

      return {
        sessions: new Map(state.sessions).set(sessionId, session),
      };
    });
  },

  appendToCommandStream: (sessionId: string, cmdId: string, flowData: FlowData) => {
    console.log(`[useShellStore][${new Date().toISOString()}] appendToCommandStream called:`, {
      sessionId,
      cmdId,
      elementType: flowData.elementType,
    });
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) {
        console.error(`[useShellStore][${new Date().toISOString()}] Session '${sessionId}' not found`);
        return state;
      }

      const commandStream = session.stream.getSubstream(cmdId);
      if (!commandStream) {
        console.error(
          `[useShellStore][${new Date().toISOString()}] Command '${cmdId}' not found in session '${sessionId}'`,
        );
        return state;
      }

      commandStream.append(flowData);

      console.log(`[useShellStore][${new Date().toISOString()}] FlowData appended to command stream:`, {
        sessionId,
        cmdId,
        itemCount: commandStream.count,
      });

      return {
        sessions: new Map(state.sessions).set(sessionId, session),
      };
    });
  },

  clearStream: (sessionId: string) => {
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) {
        console.error(`[useShellStore] Session '${sessionId}' not found`);
        return state;
      }
      session.stream.clear();

      return {
        sessions: new Map(state.sessions).set(sessionId, session),
      };
    });
  },

  // Alias for clearStream for backward compatibility
  clearLog: (sessionId: string) => {
    get().clearStream(sessionId);
  },
}));
