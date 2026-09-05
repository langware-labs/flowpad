import { useEffect } from 'react';
import { asyncSdkInit } from '@sdk';
import { usePrimaryContentReady } from '@sdk/react/primary-content';

/** Primary identity, refs and content have rendered and painted before prefetch. */
export function useAsyncSdkInit(): void {
  const ready = usePrimaryContentReady();
  useEffect(() => { if (ready) void asyncSdkInit(); }, [ready]);
}
