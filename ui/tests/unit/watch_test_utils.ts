/** Shared harness for the watch-count tests: the real store, one seeded process, counted POSTs. */
import { AgenticProcess, apiClient, dataManager, ProcessStatus, TypeId } from '@sdk';
import { vi } from 'vitest';

interface StoreInternals {
  getRef(t: TypeId): { entity: unknown; status: string };
  watches: { get(t: TypeId): number | undefined };
  onDataOp(t: string, op: string, d: object): void;
}
export const store = dataManager as unknown as StoreInternals;

export const settle = () => new Promise<void>((r) => setTimeout(r, 0));
let spy: ReturnType<typeof spyPost> | undefined;
export const spyPost = () => {
  const created = vi.spyOn(apiClient, 'post');
  spy = created;
  return created;
};
/** How many POSTs went to a route ending in `suffix`, on the latest `spyPost()`. */
export const posts = (suffix: string) => (spy?.mock.calls ?? []).filter(([url]) => String(url).endsWith(suffix)).length;

export function watchedProcess(processId: string) {
  const typeId = new TypeId(AgenticProcess.type, processId);
  return {
    typeId,
    /** Holders of the watch on the process, as the store counts them. */
    count: () => store.watches.get(typeId) ?? 0,
    /** Put the process in the store as a loaded entity. */
    seedProcess: (status = ProcessStatus.RUNNING): AgenticProcess => {
      const ref = store.getRef(typeId);
      const proc = new AgenticProcess({ id: processId, status });
      ref.entity = proc;
      ref.status = 'READY';
      return proc;
    },
  };
}
