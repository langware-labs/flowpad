/** Process-scoped hook payload and runtime callback registry. */

export interface AgentHookData {
  webhook_type: 'agent_hook';
  agent_hook_id?: string | null;
  agentic_process_id?: string | null;
  hook_data: Record<string, unknown>;
  hook_entry_id?: string | null;
  hook_metadata?: Record<string, unknown> | null;
  hook_file_path?: string | null;
  process_entry?: Record<string, unknown> | null;
}

export type ProcessHookCallback = (data: AgentHookData) => void | Promise<void>;

let nextToken = 1;
const callbacks = new Map<string, Map<number, ProcessHookCallback>>();

export function registerProcessHookCallback(processId: string, callback: ProcessHookCallback): () => void {
  if (typeof callback !== 'function') throw new TypeError('process hook callback must be callable');
  const token = nextToken++;
  const registrations = callbacks.get(processId) ?? new Map<number, ProcessHookCallback>();
  registrations.set(token, callback);
  callbacks.set(processId, registrations);
  return () => {
    const current = callbacks.get(processId);
    current?.delete(token);
    if (current?.size === 0) callbacks.delete(processId);
  };
}

export async function dispatchProcessHook(processId: string, data: AgentHookData): Promise<void> {
  const snapshot = [...(callbacks.get(processId)?.values() ?? [])];
  for (const callback of snapshot) {
    try {
      await callback(data);
    } catch (error) {
      console.error(`[AgenticProcess.onHook] callback failed for ${processId}`, error);
    }
  }
}

export function clearProcessHookCallbacks(processId?: string): void {
  if (processId === undefined) callbacks.clear();
  else callbacks.delete(processId);
}
