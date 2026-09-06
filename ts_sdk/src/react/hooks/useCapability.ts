import { LazyAsset } from '../../lazy';
import { useLazyAsset } from './useLazyAsset';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { CapabilitySnapshot, capabilityManager } from '../../capabilities';
import { AgenticProcess } from '../../process/agentic-process';
import { TypeId } from '../../models/TypeId';
import { useEntity } from './entity-hooks';

export interface UseCapabilityOptions {
  autoCheck?: boolean;
}

export interface UseCapabilityResult extends CapabilitySnapshot {
  isLoading: boolean;
  error: unknown;
  activeProcess: AgenticProcess | null | undefined;
  refetch: () => Promise<void>;
  test: () => Promise<CapabilitySnapshot>;
  setup: () => Promise<CapabilitySnapshot>;
}

export function useCapability(kind: string, options: UseCapabilityOptions = {}): UseCapabilityResult {
  const autoCheck = options.autoCheck !== false;
  const [version, setVersion] = useState<number>(0);
  const metadata = useLazyAsset(LazyAsset.Capabilities, undefined, { priority: autoCheck ? 'demand' : 'background' });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => capabilityManager.subscribe(() => setVersion((current: number) => current + 1)), []);

  useEffect(() => {
    if (!autoCheck || !metadata.isSuccess) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const load = capabilityManager.ensureChecked(kind);
    load
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [autoCheck, kind, metadata.isSuccess]);

  const snapshot = useMemo(() => capabilityManager.getSnapshot(kind), [kind, version]);

  const processTypeId = useMemo(() => {
    if (!snapshot.processId) return null;
    try {
      return new TypeId(AgenticProcess.type, snapshot.processId);
    } catch {
      return null;
    }
  }, [snapshot.processId]);

  const { data: activeProcess } = useEntity<AgenticProcess>(processTypeId, {
    enabled: !!processTypeId,
    watch: true,
  });

  const run = useCallback(
    async (operation: 'load' | 'test' | 'setup') => {
      setIsLoading(true);
      setError(null);
      try {
        if (operation === 'load') {
          await capabilityManager.load(true);
          return capabilityManager.getSnapshot(kind);
        }
        return await capabilityManager[operation](kind);
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [kind],
  );

  return {
    ...snapshot,
    isLoading: isLoading || metadata.isLoading,
    error: error ?? metadata.error,
    activeProcess,
    refetch: () => run('load').then(() => undefined),
    test: () => run('test'),
    setup: () => run('setup'),
  };
}
