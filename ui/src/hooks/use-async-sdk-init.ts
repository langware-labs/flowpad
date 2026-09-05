import { useEffect } from 'react';
import { asyncSdkInit } from '@sdk';

/** Leave a paint opportunity before optional SDK services start. */
export function useAsyncSdkInit(): void {
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { void asyncSdkInit(); });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
}
